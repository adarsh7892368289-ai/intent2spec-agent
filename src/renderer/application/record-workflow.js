'use strict';

import storage from '../infrastructure/idb-repository.js';
import { dispatch, getState, TRACKING_MODES, SECTIONS } from '../state.js';
import { createReport, selectReport } from './report-manager.js';
import { Toast } from '../components/toast.js';

const api = window.elementTrackerAPI;

// Accumulate everything captured during a session; on stop, persist it as one
// report. (The extension stored per-event; the desktop model is one report per
// recording session, matching scans.)
let _elements = [];
let _statBuffer = {};
let _session = { url: '', mode: TRACKING_MODES.INTERACTIONS, engine: null };

function browserDescriptor(state) {
  return state.selectedBrowser
    ? {
        browserType: state.selectedBrowser.browserType,
        channel: state.selectedBrowser.channel ?? null,
        executablePath: state.selectedBrowser.executablePath ?? null,
      }
    : 'chromium';
}

// A session is "live" from the moment the user clicks Start: the injected
// addInitScript arms capture on first document load, which can be BEFORE
// startRecordSession resolves (RECORD_STARTED). Accept events while 'starting'
// too, so the first clicks/inputs on the landing page aren't dropped.
function _sessionLive() {
  const phase = getState().recordPhase;
  return phase === 'recording' || phase === 'starting';
}

export function initRecordListeners() {
  api.onRecordEvent?.((payload) => {
    const el = payload?.element;
    if (!el || !_sessionLive()) {
      return;
    }
    _elements.push(el);
    _statBuffer[el.captureType] = (_statBuffer[el.captureType] ?? 0) + 1;
    dispatch('RECORD_EVENT', { captureType: el.captureType });
  });

  api.onRecordScan?.((payload) => {
    if (!_sessionLive()) {
      return;
    }
    const elements = payload?.scan?.elements ?? [];
    for (const el of elements) {
      _elements.push(el);
    }
    _statBuffer.scans = (_statBuffer.scans ?? 0) + 1;
    dispatch('RECORD_SCAN', { elementCount: elements.length });
  });

  api.onRecordSessionClosed?.(() => {
    if (getState().recordPhase === 'idle') {
      return;
    }
    // User closed the controlled browser — finalize whatever was captured.
    void finalizeSession('The controlled browser was closed.');
  });
}

// Start a recording session for the given section's mode (interactions | hybrid).
export async function startRecording({ url, section }) {
  const state = getState();
  if (state.recordPhase === 'recording' || state.recordPhase === 'starting') {
    return;
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    Toast.error('Enter a valid http(s) URL');
    return;
  }

  const mode = section === SECTIONS.HYBRID ? TRACKING_MODES.HYBRID : TRACKING_MODES.INTERACTIONS;
  dispatch('RECORD_STARTING', { section });
  _elements = [];
  _statBuffer = {};
  _session = { url, mode, engine: null };

  const profiles = await storage.getAllProfiles();

  try {
    const res = await api.startRecordSession({
      url,
      mode,
      settings: state.settings,
      profiles,
      browser: browserDescriptor(state),
    });
    if (!res?.success) {
      dispatch('RECORD_FAILED');
      Toast.error('Could not start recording', res?.error ?? undefined);
      return;
    }
    _session.engine = res.engine ?? browserDescriptor(state)?.browserType ?? 'chromium';
    dispatch('RECORD_STARTED', { sessionId: res.sessionId });
    Toast.success('Recording started', 'Interact with the controlled browser window.');
  } catch (err) {
    dispatch('RECORD_FAILED');
    Toast.error('Could not start recording', err?.message);
  }
}

export async function stopRecording() {
  if (getState().recordPhase !== 'recording') {
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
  await finalizeSession();
}

// Persist the buffered session as a report (if anything was captured) and reset.
async function finalizeSession(closedReason) {
  if (getState().recordPhase === 'idle') {
    return;
  }
  const elements = _elements;
  const stats = _statBuffer;
  const session = _session;
  _elements = [];
  _statBuffer = {};
  dispatch('RECORD_STOPPED');

  if (elements.length === 0) {
    Toast.info('Recording stopped', closedReason ?? 'No elements were captured.');
    return;
  }

  try {
    const report = await createReport({
      mode: session.mode,
      url: session.url,
      engine: session.engine,
      elements,
      source: 'record',
      statBreakdown: stats,
    });
    Toast.success(`Saved ${elements.length} captured element${elements.length === 1 ? '' : 's'}`);
    await selectReport(report.id);
  } catch (err) {
    Toast.error('Failed to save recording', err?.message);
  }
}

// Hybrid on-demand scan during a live session.
export async function triggerHybridScan({ filters }) {
  if (getState().recordPhase !== 'recording') {
    return;
  }
  const list = (filters ?? []).map((f) => String(f).trim()).filter(Boolean);
  await api.triggerRecordScan({ filters: list });
}
