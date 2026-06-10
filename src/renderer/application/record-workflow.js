'use strict';

import storage from '../infrastructure/idb-repository.js';
import { dispatch, getState } from '../state.js';
import { refreshCounts, refreshUsage } from './data-manager.js';
import { Toast } from '../components/toast.js';

const api = window.elementTrackerAPI;

// Buffer streamed elements and flush to IndexedDB periodically (mirrors the
// extension's batched writes) to avoid a transaction per click.
let _buffer = [];
let _flushTimer = null;
let _activeSessionId = null;
let _activeMode = null;
let _statBuffer = {};

const FLUSH_INTERVAL_MS = 1500;

function scheduleFlush() {
  if (_flushTimer) {
    return;
  }
  _flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
}

async function flushBuffer() {
  _flushTimer = null;
  if (_buffer.length === 0 && Object.keys(_statBuffer).length === 0) {
    return;
  }
  const elements = _buffer;
  const stats = _statBuffer;
  _buffer = [];
  _statBuffer = {};
  const mode = _activeMode;
  const sessionId = _activeSessionId ?? `rec_${Date.now()}`;
  try {
    if (elements.length > 0) {
      await storage.addElements(mode, sessionId, elements);
    }
    if (Object.keys(stats).length > 0) {
      const existing = (await storage.getStats(mode)).counts ?? {};
      const merged = { ...existing };
      for (const [k, v] of Object.entries(stats)) {
        merged[k] = (merged[k] ?? 0) + v;
      }
      await storage.setStats(mode, merged);
    }
    await refreshCounts();
    await refreshUsage();
  } catch (err) {
    console.error('[record-workflow] flush failed', err);
  }
}

// Push-bridge listeners are installed once at app init.
export function initRecordListeners() {
  api.onRecordEvent?.((payload) => {
    const el = payload?.element;
    if (!el) {
      return;
    }
    _buffer.push(el);
    _statBuffer[el.captureType] = (_statBuffer[el.captureType] ?? 0) + 1;
    dispatch('RECORD_EVENT', { captureType: el.captureType });
    scheduleFlush();
  });

  api.onRecordScan?.((payload) => {
    const elements = payload?.scan?.elements ?? [];
    for (const el of elements) {
      _buffer.push(el);
    }
    _statBuffer.scans = (_statBuffer.scans ?? 0) + 1;
    _statBuffer.elements = (_statBuffer.elements ?? 0) + elements.length;
    dispatch('RECORD_SCAN', { elementCount: elements.length });
    scheduleFlush();
  });

  api.onRecordSessionClosed?.(() => {
    if (getState().recordPhase === 'idle') {
      return;
    }
    void flushBuffer();
    dispatch('RECORD_STOPPED');
    Toast.info('Recording stopped', 'The controlled browser was closed.');
  });
}

export async function startRecording({ url }) {
  const state = getState();
  if (state.recordPhase === 'recording' || state.recordPhase === 'starting') {
    return;
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    Toast.error('Enter a valid http(s) URL');
    return;
  }

  dispatch('RECORD_STARTING', { url });
  _activeMode = state.mode;
  _activeSessionId = null;
  _buffer = [];
  _statBuffer = {};

  const profiles = await storage.getAllProfiles();
  const browser = state.selectedBrowser
    ? {
        browserType: state.selectedBrowser.browserType,
        channel: state.selectedBrowser.channel ?? null,
        executablePath: state.selectedBrowser.executablePath ?? null,
      }
    : 'chromium';

  try {
    const res = await api.startRecordSession({
      url,
      mode: state.mode,
      settings: state.settings,
      profiles,
      browser,
    });
    if (!res?.success) {
      dispatch('RECORD_FAILED');
      Toast.error('Could not start recording', res?.error ?? undefined);
      return;
    }
    _activeSessionId = res.sessionId;
    dispatch('RECORD_STARTED', { sessionId: res.sessionId });
    Toast.success('Recording started', 'Interact with the controlled browser window.');
  } catch (err) {
    dispatch('RECORD_FAILED');
    Toast.error('Could not start recording', err?.message);
  }
}

export async function stopRecording() {
  const state = getState();
  if (state.recordPhase !== 'recording') {
    return;
  }
  try {
    const res = await api.stopRecordSession();
    if (res?.profiles) {
      await storage.mergeProfiles(res.profiles);
    }
  } catch (err) {
    console.error('[record-workflow] stop failed', err);
  }
  await flushBuffer();
  dispatch('RECORD_STOPPED');
  await refreshCounts();
  Toast.success('Recording saved');
}

// Hybrid on-demand scan during a live session.
export async function triggerHybridScan({ filters }) {
  if (getState().recordPhase !== 'recording') {
    return;
  }
  const list = (filters ?? []).map((f) => String(f).trim()).filter(Boolean);
  await api.triggerRecordScan({ filters: list });
}
