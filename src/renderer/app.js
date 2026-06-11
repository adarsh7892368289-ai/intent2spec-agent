'use strict';

import { getState, dispatch, subscribe, SECTIONS } from './state.js';
import { Toast } from './components/toast.js';
import { Modal } from './components/modal.js';
import { createBrowserSelector } from './components/browser-selector.js';
import { createReportList } from './components/report-list.js';
import { createReportDetailsPanel } from './components/report-details-panel.js';
import {
  initializeReports,
  persistSettings,
  selectReport,
  deleteReport,
  clearAllReports,
} from './application/report-manager.js';
import { runScan, cancelScan } from './application/scan-workflow.js';
import {
  initRecordListeners,
  startRecording,
  stopRecording,
  triggerHybridScan,
} from './application/record-workflow.js';
import { exportReport } from './application/export-workflow.js';
import {
  runAiGeneration,
  cancelAiGeneration,
  exportAiSpec,
  checkClaudeCli,
  refreshAiReportOptions,
  setOnAiTestSaved,
} from './application/ai-workflow.js';
import { createAiTestList } from './components/ai-test-list.js';
import { createAiTestDetailsPanel } from './components/ai-test-details-panel.js';
import { selectAiTest, deleteAiTest, clearAllAiTests } from './application/ai-test-manager.js';
import { refreshAiTests } from './application/report-manager.js';

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

api.setWindowTitle?.('Agentic Test Automation');

let _detailsPanel = null;
let _aiDetailsPanel = null;

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
  // Opening a section closes any open report details.
  dispatch('REPORT_CLOSED');
  document.querySelectorAll('[data-main-pane-section]').forEach((btn) => {
    btn.setAttribute('aria-selected', String(btn.dataset.mainPaneSection === section));
  });
  syncPanes(getState());
  if (section === 'ai') {
    void checkClaudeCli();
    refreshAiReportOptions(getState().reports);
  }
}

// Show a details panel when a report OR an AI test is selected; otherwise show
// the active capture section.
function syncPanes(state) {
  const reportOpen = !!state.selectedReportId;
  const aiOpen = !!state.selectedAiTestId;
  const anyDetails = reportOpen || aiOpen;
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = anyDetails || panel.id !== `section-${state.section}`;
  });
  const reportDetails = document.getElementById('report-details');
  if (reportDetails) {
    reportDetails.hidden = !reportOpen;
  }
  const aiDetails = document.getElementById('ai-test-details');
  if (aiDetails) {
    aiDetails.hidden = !aiOpen;
  }
}

// Toggle the left-pane between the Reports list and the AI Tests list.
function syncLeftTab(state) {
  const tab = state.leftTab || 'reports';
  const reportsPane = document.getElementById('reports-pane');
  const aiPane = document.getElementById('ai-tests-pane');
  if (reportsPane) {
    reportsPane.hidden = tab !== 'reports';
  }
  if (aiPane) {
    aiPane.hidden = tab !== 'ai';
  }
  document.querySelectorAll('[data-left-tab]').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.leftTab === tab));
  });
  const title = document.getElementById('left-pane-title');
  if (title) {
    title.textContent = tab === 'ai' ? 'AI Tests' : 'Reports';
  }
  const clearReports = document.getElementById('clear-all-reports-btn');
  const clearAi = document.getElementById('clear-all-ai-btn');
  if (clearReports) {
    clearReports.hidden = tab !== 'reports';
  }
  if (clearAi) {
    clearAi.hidden = tab !== 'ai';
  }
}

// ---- live stats -------------------------------------------------------------

const LIVE_STAT_FIELDS = [
  { key: 'click', label: 'Clicks' },
  { key: 'input', label: 'Inputs' },
  { key: 'form', label: 'Forms' },
  { key: 'navigation', label: 'Navigation' },
  { key: 'scroll', label: 'Scroll' },
];

function renderLiveStats(state) {
  const fields = [...LIVE_STAT_FIELDS];
  if (state.recordSection === SECTIONS.HYBRID) {
    fields.push({ key: 'scan', label: 'Scans' }, { key: 'elements', label: 'Elements' });
  }
  document.querySelectorAll('[data-live-stats]').forEach((hostEl) => {
    hostEl.replaceChildren();
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
      hostEl.appendChild(card);
    }
  });
}

// ---- storage ----------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes) {
    return '0 MB';
  }
  const mb = bytes / (1024 * 1024);
  return mb < 1 ? `${(bytes / 1024).toFixed(0)} KB` : `${mb.toFixed(1)} MB`;
}

// Export a stored AI test's generated spec via the save dialog.
async function exportSavedAiTest(test) {
  if (!test?.spec) {
    Toast.warning('Nothing to export', 'This test has no generated spec.');
    return;
  }
  const res = await api.exportFile({ content: test.spec, filename: 'generated.spec.ts', format: 'js' });
  if (res?.success) {
    Toast.success('Spec exported');
  } else if (res?.reason !== 'cancelled') {
    Toast.error('Export failed', res?.error ?? undefined);
  }
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

  // Browser selector in every section.
  document.querySelectorAll('[data-browser-slot]').forEach((slot) => createBrowserSelector(slot));

  // Reports list (sidebar).
  createReportList(
    document.getElementById('reports-list'),
    document.getElementById('reports-empty'),
    {
      onSelect: (id) => void selectReport(id),
      onExport: (report, format) => void exportReport(report, format),
      onDelete: async (report) => {
        const ok = await Modal.confirm('Delete report', `Delete this ${report.mode} report?`, {
          confirmText: 'Delete',
          destructive: true,
        });
        if (ok) {
          await deleteReport(report.id);
          Toast.success('Report deleted');
        }
      },
    }
  );

  // Report details (main pane).
  _detailsPanel = createReportDetailsPanel(document.getElementById('report-details'), {
    onClose: () => dispatch('REPORT_CLOSED'),
    onExport: (report, format) => void exportReport(report, format),
  });

  document.getElementById('clear-all-reports-btn')?.addEventListener('click', async () => {
    if ((getState().reports ?? []).length === 0) {
      return;
    }
    const ok = await Modal.confirm('Clear all reports', 'Delete every stored report?', {
      confirmText: 'Clear all',
      destructive: true,
    });
    if (ok) {
      await clearAllReports();
      Toast.success('All reports cleared');
    }
  });

  // ---- AI Tests list + details ----
  createAiTestList(document.getElementById('ai-tests-list'), document.getElementById('ai-tests-empty'), {
    onSelect: (id) => selectAiTest(id),
    onDelete: async (t) => {
      const ok = await Modal.confirm('Delete AI test', 'Delete this generated test?', {
        confirmText: 'Delete',
        destructive: true,
      });
      if (ok) {
        await deleteAiTest(t.id);
        Toast.success('AI test deleted');
      }
    },
  });

  _aiDetailsPanel = createAiTestDetailsPanel(document.getElementById('ai-test-details'), {
    onClose: () => dispatch('AI_TEST_CLOSED'),
    onExport: (test) => void exportSavedAiTest(test),
  });

  // Left-pane tab switcher.
  document.querySelectorAll('[data-left-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dispatch('LEFT_TAB_CHANGED', { tab: btn.dataset.leftTab });
      syncLeftTab(getState());
    });
  });

  document.getElementById('clear-all-ai-btn')?.addEventListener('click', async () => {
    if ((getState().aiTests ?? []).length === 0) {
      return;
    }
    const ok = await Modal.confirm('Clear all AI tests', 'Delete every generated test?', {
      confirmText: 'Clear all',
      destructive: true,
    });
    if (ok) {
      await clearAllAiTests();
      Toast.success('All AI tests cleared');
    }
  });

  // Refresh the AI-tests list when a run finishes; switch the left pane to it.
  setOnAiTestSaved(() => {
    void refreshAiTests().then(() => {
      dispatch('LEFT_TAB_CHANGED', { tab: 'ai' });
      syncLeftTab(getState());
    });
  });

  initRecordListeners();

  // ---- capture-type toggles (shared settings across sections) ----
  document.querySelectorAll('[data-capture-toggles] input[data-setting]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      dispatch('SETTING_TOGGLED', { key: e.target.dataset.setting, value: e.target.checked });
      void persistSettings();
      // keep the other section's mirror toggles in sync
      document
        .querySelectorAll(`[data-capture-toggles] input[data-setting="${e.target.dataset.setting}"]`)
        .forEach((other) => {
          other.checked = e.target.checked;
        });
    });
  });

  // ---- record start/stop (Interactions + Hybrid) ----
  document.querySelectorAll('[data-record-start]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.recordStart;
      const urlId = section === 'hybrid' ? 'hybrid-url' : 'interactions-url';
      const url = document.getElementById(urlId)?.value?.trim();
      void startRecording({ url, section });
    });
  });
  document.querySelectorAll('[data-record-stop]').forEach((btn) => {
    btn.addEventListener('click', () => void stopRecording());
  });
  document.getElementById('hybrid-scan-now-btn')?.addEventListener('click', () => {
    const filters = (document.getElementById('hybrid-filters')?.value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void triggerHybridScan({ filters });
    Toast.info('Scanning current page…');
  });

  // ---- scan ----
  document.getElementById('scan-btn')?.addEventListener('click', () => {
    const url = document.getElementById('scan-url')?.value?.trim();
    const filters = (document.getElementById('scan-filters')?.value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    void runScan({ url, filters });
  });
  document.getElementById('scan-cancel-btn')?.addEventListener('click', () => void cancelScan());

  // ---- AI automation ----
  document.getElementById('ai-run-btn')?.addEventListener('click', () => void runAiGeneration());
  document.getElementById('ai-cancel-btn')?.addEventListener('click', () => void cancelAiGeneration());
  document.getElementById('ai-export-btn')?.addEventListener('click', () => void exportAiSpec());

  ['interactions-url', 'hybrid-url'].forEach((id) => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.target.closest('.panel')?.querySelector('[data-record-start]')?.click();
      }
    });
  });
  document.getElementById('scan-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      document.getElementById('scan-btn')?.click();
    }
  });

  // ---- reactive UI ----
  let _lastSelected = null;
  let _lastElements = null;
  let _lastReportsRef = null;
  let _lastAiSelected = null;
  subscribe((state) => {
    syncPanes(state);

    // Keep the AI grounding-report dropdown in sync with reports.
    if (state.reports !== _lastReportsRef) {
      _lastReportsRef = state.reports;
      refreshAiReportOptions(state.reports);
    }

    // Record buttons + live panel (per section).
    const recording = state.recordPhase === 'recording';
    const starting = state.recordPhase === 'starting';
    document.querySelectorAll('[data-record-start]').forEach((b) => {
      b.hidden = recording;
      b.disabled = starting;
      b.querySelector('.btn-label').textContent = starting ? 'Starting…' : 'Start Recording';
    });
    document.querySelectorAll('[data-record-stop]').forEach((b) => {
      b.hidden = !recording;
    });
    const scanNow = document.getElementById('hybrid-scan-now-btn');
    if (scanNow) {
      scanNow.hidden = !(recording && state.recordSection === SECTIONS.HYBRID);
    }
    document.querySelectorAll('[data-record-live]').forEach((card) => {
      // only show the live card inside the section that owns the session
      const sectionId = card.closest('.tab-panel')?.id?.replace('section-', '');
      card.hidden = !(recording && state.recordSection === sectionId);
    });
    renderLiveStats(state);

    // Scan progress.
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
      progress.hidden = !scanning;
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

    // Report details render (only when selection or its elements changed).
    if (state.selectedReportId !== _lastSelected || state.selectedReportElements !== _lastElements) {
      _lastSelected = state.selectedReportId;
      _lastElements = state.selectedReportElements;
      if (state.selectedReportId) {
        const report = state.reports.find((r) => r.id === state.selectedReportId);
        if (report && state.selectedReportElements != null) {
          _detailsPanel.render(report, state.selectedReportElements);
        } else if (report) {
          _detailsPanel.renderEmpty('Loading…');
        }
      } else {
        _detailsPanel.clear();
      }
    }

    // AI-test details render (only when the selection changed).
    if (state.selectedAiTestId !== _lastAiSelected) {
      _lastAiSelected = state.selectedAiTestId;
      if (state.selectedAiTestId) {
        const test = (state.aiTests ?? []).find((t) => t.id === state.selectedAiTestId);
        _aiDetailsPanel?.render(test);
      } else {
        _aiDetailsPanel?.clear();
      }
    }

    // Storage.
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

  api.getVersion?.().then((v) => {
    const hint = document.querySelector('.status-right__hint');
    if (hint && v) {
      hint.textContent = `v${v}`;
    }
  });

  // ---- load persisted reports + settings ----
  // Degrade gracefully if IndexedDB is unavailable (e.g. a locked-down profile):
  // the app stays usable, just without persisted history this session.
  try {
    await initializeReports();
  } catch (err) {
    console.error('[app] storage init failed — continuing without persistence', err);
    Toast.warning('Storage unavailable', 'Captures and AI tests won’t be saved this session.');
  }

  const st = getState();
  document.querySelectorAll('[data-capture-toggles] input[data-setting]').forEach((cb) => {
    cb.checked = st.settings[cb.dataset.setting] !== false;
  });

  activateSection(SECTIONS.INTERACTIONS);
  syncLeftTab(getState());
});
