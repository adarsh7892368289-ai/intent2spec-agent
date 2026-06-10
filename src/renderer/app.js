'use strict';

import { getState, dispatch, subscribe, TRACKING_MODES } from './state.js';
import { Toast } from './components/toast.js';
import { Modal } from './components/modal.js';
import { createBrowserSelector } from './components/browser-selector.js';
import { createCapturesList } from './components/captures-list.js';
import {
  initializeData,
  clearMode,
  clearAllModes,
  persistSettings,
} from './application/data-manager.js';
import { runScan, cancelScan } from './application/scan-workflow.js';
import {
  initRecordListeners,
  startRecording,
  stopRecording,
  triggerHybridScan,
} from './application/record-workflow.js';
import { exportMode } from './application/export-workflow.js';

const api = window.elementTrackerAPI;

if (!api) {
  const showBridgeFatal = () => {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                  flex-direction:column;gap:16px;background:#0f1523;font-family:system-ui">
        <p style="font-size:15px;font-weight:600;color:#e8ecf2;margin:0">Failed to initialize</p>
        <p style="font-size:13px;color:#a0aec0;margin:0">Window bridge unavailable — restart the application.</p>
      </div>`;
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showBridgeFatal);
  } else {
    showBridgeFatal();
  }
  throw new Error('window.elementTrackerAPI is undefined');
}

api.setWindowTitle?.('Element Tracker');

// ---- theme ------------------------------------------------------------------

function toggleTheme() {
  const root = document.documentElement;
  const next = (root.dataset.theme === 'light' ? 'light' : 'dark') === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('ui-theme', next);
  } catch {
    void 0;
  }
  syncThemeToggleButton();
}

function syncThemeToggleButton() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) {
    return;
  }
  const isDark = document.documentElement.dataset.theme !== 'light';
  btn.setAttribute('aria-pressed', String(!isDark));
  btn.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
}

// ---- section nav ------------------------------------------------------------

function activateSection(section) {
  dispatch('SECTION_CHANGED', { section });
  document.querySelectorAll('[data-main-pane-section]').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.mainPaneSection === section));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `section-${section}`;
  });
}

// ---- live stats rendering ---------------------------------------------------

const LIVE_STAT_FIELDS = [
  { key: 'click', label: 'Clicks' },
  { key: 'input', label: 'Inputs' },
  { key: 'form', label: 'Forms' },
  { key: 'navigation', label: 'Navigation' },
  { key: 'scroll', label: 'Scroll' },
];

function renderLiveStats(state) {
  const host = document.getElementById('live-stats');
  if (!host) {
    return;
  }
  const fields = [...LIVE_STAT_FIELDS];
  if (state.mode === TRACKING_MODES.HYBRID) {
    fields.push({ key: 'scan', label: 'Scans' }, { key: 'elements', label: 'Elements' });
  }
  host.replaceChildren();
  for (const f of fields) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = String(state.liveCounts?.[f.key] ?? 0);
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = f.label;
    card.append(v, l);
    host.appendChild(card);
  }
}

// ---- storage display --------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) {
    return '0 MB';
  }
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? `${(bytes / 1024).toFixed(0)} KB` : `${mb.toFixed(1)} MB`;
}

// ---- boot -------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  if (api.platform === 'darwin') {
    document.documentElement.classList.add('platform-darwin');
  }

  syncThemeToggleButton();
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  document.querySelectorAll('[data-main-pane-section]').forEach((btn) => {
    btn.addEventListener('click', () => activateSection(btn.dataset.mainPaneSection));
  });

  api.onMenuAction?.((action) => {
    if (action === 'toggle-sidebar') {
      const panel = document.getElementById('left-panel');
      if (panel) {
        panel.dataset.collapsed = String(panel.dataset.collapsed !== 'true');
      }
    }
  });

  api.onAppNotification?.((payload) => {
    if (payload?.title) {
      Toast.show(payload.title, payload.tier ?? 'info', payload.durationMs, payload.body ?? null);
    }
  });

  // Components
  createBrowserSelector(document.getElementById('browser-selector-slot'));
  createBrowserSelector(document.getElementById('scan-browser-selector-slot'));
  createCapturesList(document.getElementById('captures-list'), {
    onExport: (mode, format) => exportMode(mode, format),
    onClear: async (mode, label) => {
      const ok = await Modal.confirm('Clear data', `Delete all captured ${label} data?`, {
        confirmText: 'Clear',
        destructive: true,
      });
      if (ok) {
        await clearMode(mode);
        Toast.success(`Cleared ${label} data`);
      }
    },
    onClearAll: async () => {
      const ok = await Modal.confirm('Clear all data', 'Delete all captured data across every mode?', {
        confirmText: 'Clear all',
        destructive: true,
      });
      if (ok) {
        await clearAllModes();
        Toast.success('Cleared all data');
      }
    },
  });

  initRecordListeners();

  // ---- record controls ----
  document.querySelectorAll('input[name="record-mode"]').forEach((r) => {
    r.addEventListener('change', (e) => {
      if (e.target.checked) {
        dispatch('MODE_CHANGED', { mode: e.target.value });
        void persistSettings();
      }
    });
  });

  document.querySelectorAll('#capture-toggles input[data-setting]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      dispatch('SETTING_TOGGLED', { key: e.target.dataset.setting, value: e.target.checked });
      void persistSettings();
    });
  });

  document.getElementById('record-start-btn')?.addEventListener('click', () => {
    const url = document.getElementById('record-url')?.value?.trim();
    void startRecording({ url });
  });
  document.getElementById('record-stop-btn')?.addEventListener('click', () => void stopRecording());
  document.getElementById('hybrid-scan-btn')?.addEventListener('click', () => {
    void triggerHybridScan({ filters: [] });
    Toast.info('Scanning current page…');
  });

  // ---- scan controls ----
  document.getElementById('scan-btn')?.addEventListener('click', () => {
    const url = document.getElementById('scan-url')?.value?.trim();
    const filters = (document.getElementById('scan-filters')?.value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void runScan({ url, filters });
  });
  document.getElementById('scan-cancel-btn')?.addEventListener('click', () => void cancelScan());

  document.getElementById('record-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('record-start-btn')?.click();
    }
  });
  document.getElementById('scan-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('scan-btn')?.click();
    }
  });

  // ---- reactive UI updates ----
  subscribe((state) => {
    // Record buttons / live panel
    const recording = state.recordPhase === 'recording';
    const starting = state.recordPhase === 'starting';
    const startBtn = document.getElementById('record-start-btn');
    const stopBtn = document.getElementById('record-stop-btn');
    const hybridBtn = document.getElementById('hybrid-scan-btn');
    const liveCard = document.getElementById('record-live');
    if (startBtn) {
      startBtn.hidden = recording;
      startBtn.disabled = starting;
      startBtn.querySelector('.btn-label').textContent = starting ? 'Starting…' : 'Start Recording';
    }
    if (stopBtn) {
      stopBtn.hidden = !recording;
    }
    if (hybridBtn) {
      hybridBtn.hidden = !(recording && state.mode === TRACKING_MODES.HYBRID);
    }
    if (liveCard) {
      liveCard.hidden = !recording;
    }
    renderLiveStats(state);

    // Scan progress / buttons
    const scanning = state.scanPhase === 'scanning';
    const scanBtn = document.getElementById('scan-btn');
    const scanCancel = document.getElementById('scan-cancel-btn');
    const progress = document.getElementById('scan-progress');
    const bar = document.getElementById('scan-progress-bar');
    const plabel = document.getElementById('scan-progress-label');
    if (scanBtn) {
      scanBtn.disabled = scanning;
      scanBtn.querySelector('.btn-label').textContent = scanning ? 'Scanning…' : 'Scan Page';
    }
    if (scanCancel) {
      scanCancel.hidden = !scanning;
    }
    if (progress) {
      progress.hidden = !scanning && state.scanPhase !== 'done';
      progress.setAttribute('aria-valuenow', String(state.scanProgress.pct ?? 0));
    }
    if (bar) {
      bar.style.width = `${state.scanProgress.pct ?? 0}%`;
    }
    if (plabel) {
      plabel.textContent = state.scanProgress.label ?? '';
    }
    const scanErr = document.getElementById('scan-error');
    if (scanErr) {
      scanErr.textContent = state.scanPhase === 'error' ? state.scanError ?? 'Scan failed' : '';
    }

    // Storage display
    const sv = document.getElementById('storage-value');
    if (sv) {
      sv.textContent = formatBytes(state.usage?.usage ?? 0);
    }
  });

  // ---- browser detection ----
  if (typeof api.getAvailableBrowsers === 'function') {
    dispatch('BROWSER_DETECTION_STARTED');
    api
      .getAvailableBrowsers()
      .then((res) => {
        if (res?.success) {
          dispatch('BROWSERS_DETECTED', { browsers: res.browsers, detectedAt: res.detectedAt });
        } else {
          dispatch('BROWSER_DETECTION_FAILED', { error: res?.error ?? 'Browser detection failed' });
        }
      })
      .catch((err) => dispatch('BROWSER_DETECTION_FAILED', { error: err?.message ?? String(err) }));
  }

  // ---- version in status bar ----
  api.getVersion?.().then((v) => {
    const hint = document.querySelector('.status-right__hint');
    if (hint && v) {
      hint.textContent = `v${v}`;
    }
  });

  // ---- load persisted data ----
  await initializeData();

  // Reflect loaded settings into the controls.
  const st = getState();
  document.querySelectorAll('input[name="record-mode"]').forEach((r) => {
    r.checked = r.value === st.mode;
  });
  document.querySelectorAll('#capture-toggles input[data-setting]').forEach((cb) => {
    cb.checked = st.settings[cb.dataset.setting] !== false;
  });

  activateSection('record');
});
