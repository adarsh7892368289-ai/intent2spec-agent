'use strict';

// Single-source-of-truth state container (reduce/dispatch/subscribe), modeled on
// the reference app's state.js. Holds UI phase, the active mode, capture settings,
// per-mode stats + counts, the captures list for the sidebar, browser detection,
// and live record-session status.

export const TRACKING_MODES = {
  INTERACTIONS: 'interactions',
  FULL_PAGE: 'full_page',
  HYBRID: 'hybrid',
};

export const DEFAULT_SETTINGS = {
  trackingMode: TRACKING_MODES.INTERACTIONS,
  captureClicks: true,
  captureInputs: true,
  captureForms: true,
  captureNavigation: true,
  captureScroll: true,
  capturePasswordFields: false,
};

const initialState = {
  // Which main-pane section is visible.
  section: 'record',
  // Recording phase: 'idle' | 'recording'.
  recordPhase: 'idle',
  recordSessionId: null,
  recordUrl: '',
  // Scan phase: 'idle' | 'scanning' | 'done' | 'error'.
  scanPhase: 'idle',
  scanProgress: { label: '', pct: 0 },
  scanError: null,
  operationId: null,

  mode: TRACKING_MODES.INTERACTIONS,
  settings: { ...DEFAULT_SETTINGS },

  // Per-mode element counts (for the captures list) and stat breakdowns.
  counts: {
    [TRACKING_MODES.INTERACTIONS]: 0,
    [TRACKING_MODES.FULL_PAGE]: 0,
    [TRACKING_MODES.HYBRID]: 0,
  },
  stats: {},

  // Browser detection.
  selectedBrowser: null,
  availableBrowsers: [],
  browserDetectionState: 'idle',
  browserDetectionError: null,

  // Storage usage.
  usage: { usage: 0, quota: 0 },

  // Live interaction counters during a record session (transient).
  liveCounts: { click: 0, input: 0, form: 0, navigation: 0, scroll: 0, scan: 0, elements: 0 },
};

let _state = { ...initialState };
const _listeners = new Set();

export function getState() {
  return _state;
}

export function subscribe(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export function dispatch(type, payload = {}) {
  _state = reduce(_state, type, payload);
  for (const listener of _listeners) {
    try {
      listener(_state);
    } catch (err) {
      console.error('State listener error:', err);
    }
  }
}

function reduce(state, type, payload) {
  switch (type) {
    case 'SECTION_CHANGED':
      return { ...state, section: payload.section };

    case 'MODE_CHANGED':
      return {
        ...state,
        mode: payload.mode,
        settings: { ...state.settings, trackingMode: payload.mode },
      };

    case 'SETTINGS_LOADED':
      return {
        ...state,
        settings: { ...DEFAULT_SETTINGS, ...(payload.settings || {}) },
        mode: payload.settings?.trackingMode ?? state.mode,
      };

    case 'SETTING_TOGGLED':
      return {
        ...state,
        settings: { ...state.settings, [payload.key]: payload.value },
      };

    case 'COUNTS_LOADED':
      return { ...state, counts: { ...state.counts, ...payload.counts } };

    case 'STATS_LOADED':
      return { ...state, stats: payload.stats ?? {} };

    case 'USAGE_LOADED':
      return { ...state, usage: payload.usage ?? state.usage };

    // ---- record session ----
    case 'RECORD_STARTING':
      return {
        ...state,
        recordPhase: 'starting',
        recordUrl: payload.url ?? state.recordUrl,
        liveCounts: { click: 0, input: 0, form: 0, navigation: 0, scroll: 0, scan: 0, elements: 0 },
      };

    case 'RECORD_STARTED':
      return {
        ...state,
        recordPhase: 'recording',
        recordSessionId: payload.sessionId ?? null,
      };

    case 'RECORD_EVENT': {
      const t = payload.captureType;
      const live = { ...state.liveCounts };
      if (t && live[t] != null) {
        live[t] += 1;
      }
      return { ...state, liveCounts: live };
    }

    case 'RECORD_SCAN': {
      const live = { ...state.liveCounts };
      live.scan += 1;
      live.elements += payload.elementCount ?? 0;
      return { ...state, liveCounts: live };
    }

    case 'RECORD_STOPPED':
      return { ...state, recordPhase: 'idle', recordSessionId: null };

    case 'RECORD_FAILED':
      return { ...state, recordPhase: 'idle', recordSessionId: null };

    // ---- scan ----
    case 'SCAN_STARTED':
      return {
        ...state,
        scanPhase: 'scanning',
        scanProgress: { label: payload.label ?? 'Starting…', pct: payload.pct ?? 0 },
        scanError: null,
        operationId: payload.operationId ?? null,
      };

    case 'SCAN_PROGRESS':
      if (state.scanPhase !== 'scanning') {
        return state;
      }
      return { ...state, scanProgress: { label: payload.label, pct: payload.pct } };

    case 'SCAN_DONE':
      return {
        ...state,
        scanPhase: 'done',
        scanProgress: { label: 'Complete', pct: 100 },
        operationId: null,
      };

    case 'SCAN_ERROR':
      return {
        ...state,
        scanPhase: 'error',
        scanError: payload.error ?? 'Scan failed',
        operationId: null,
      };

    case 'SCAN_RESET':
      return { ...state, scanPhase: 'idle', scanProgress: { label: '', pct: 0 }, scanError: null };

    // ---- browser detection ----
    case 'BROWSER_DETECTION_STARTED':
      return { ...state, browserDetectionState: 'loading', browserDetectionError: null };

    case 'BROWSERS_DETECTED':
      return {
        ...state,
        availableBrowsers: payload.browsers ?? [],
        selectedBrowser:
          state.selectedBrowser ??
          (payload.browsers ?? []).find((b) => b.isLaunchable && b.isDefault) ??
          (payload.browsers ?? []).find((b) => b.isLaunchable) ??
          null,
        browserDetectionState: 'ready',
      };

    case 'BROWSER_DETECTION_FAILED':
      return {
        ...state,
        browserDetectionState: 'error',
        browserDetectionError: payload.error ?? 'Browser detection failed',
      };

    case 'BROWSER_SELECTED':
      return { ...state, selectedBrowser: payload.browser ?? null };

    default:
      return state;
  }
}
