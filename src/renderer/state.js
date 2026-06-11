'use strict';

// Single-source-of-truth state container (reduce/dispatch/subscribe), modeled on
// the reference app's state.js. Organized around REPORTS: a list of stored
// captures shown in the left pane, a selected report shown in the main pane, and
// three capture sections (Interactions, Element Scan, Hybrid).

export const TRACKING_MODES = {
  INTERACTIONS: 'interactions',
  FULL_PAGE: 'full_page',
  HYBRID: 'hybrid',
};

export const SECTIONS = {
  INTERACTIONS: 'interactions',
  SCAN: 'scan',
  HYBRID: 'hybrid',
};

export const DEFAULT_SETTINGS = {
  captureClicks: true,
  captureInputs: true,
  captureForms: true,
  captureNavigation: true,
  captureScroll: true,
  capturePasswordFields: false,
};

const initialState = {
  // Active capture section / tab.
  section: SECTIONS.INTERACTIONS,

  // Left-pane tab: 'reports' | 'ai'.
  leftTab: 'reports',

  // Stored reports (metadata only) + which one is open in the main pane.
  reports: [],
  selectedReportId: null,
  selectedReportElements: null,

  // Stored AI tests (full records) + which one is open in the main pane.
  aiTests: [],
  selectedAiTestId: null,

  settings: { ...DEFAULT_SETTINGS },

  // Record session: 'idle' | 'starting' | 'recording', plus which section started it.
  recordPhase: 'idle',
  recordSessionId: null,
  recordSection: null,
  liveCounts: { click: 0, input: 0, form: 0, navigation: 0, scroll: 0, scan: 0, elements: 0 },

  // Scan: 'idle' | 'scanning' | 'error'.
  scanPhase: 'idle',
  scanProgress: { label: '', pct: 0 },
  scanError: null,
  operationId: null,

  // Browser detection.
  selectedBrowser: null,
  availableBrowsers: [],
  browserDetectionState: 'idle',
  browserDetectionError: null,

  usage: { usage: 0, quota: 0 },
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

    case 'SETTINGS_LOADED':
      return { ...state, settings: { ...DEFAULT_SETTINGS, ...(payload.settings || {}) } };

    case 'SETTING_TOGGLED':
      return { ...state, settings: { ...state.settings, [payload.key]: payload.value } };

    case 'USAGE_LOADED':
      return { ...state, usage: payload.usage ?? state.usage };

    // ---- reports ----
    case 'REPORTS_LOADED':
      return { ...state, reports: payload.reports ?? [] };

    case 'REPORT_ADDED':
      return {
        ...state,
        reports: [payload.report, ...state.reports.filter((r) => r.id !== payload.report.id)],
      };

    case 'REPORT_DELETED': {
      const reports = state.reports.filter((r) => r.id !== payload.reportId);
      const wasSelected = state.selectedReportId === payload.reportId;
      return {
        ...state,
        reports,
        selectedReportId: wasSelected ? null : state.selectedReportId,
        selectedReportElements: wasSelected ? null : state.selectedReportElements,
      };
    }

    case 'REPORTS_CLEARED':
      return { ...state, reports: [], selectedReportId: null, selectedReportElements: null };

    case 'REPORT_SELECTED':
      // Opening a report closes any open AI test (one detail pane at a time).
      return {
        ...state,
        selectedReportId: payload.reportId,
        selectedReportElements: null,
        selectedAiTestId: null,
      };

    case 'REPORT_ELEMENTS_LOADED':
      if (payload.reportId !== state.selectedReportId) {
        return state;
      }
      return { ...state, selectedReportElements: payload.elements ?? [] };

    case 'REPORT_CLOSED':
      return { ...state, selectedReportId: null, selectedReportElements: null };

    // ---- left-pane tab ----
    case 'LEFT_TAB_CHANGED':
      return { ...state, leftTab: payload.tab };

    // ---- AI tests ----
    case 'AI_TESTS_LOADED':
      return { ...state, aiTests: payload.aiTests ?? [] };

    case 'AI_TEST_DELETED': {
      const aiTests = state.aiTests.filter((t) => t.id !== payload.id);
      const wasSel = state.selectedAiTestId === payload.id;
      return { ...state, aiTests, selectedAiTestId: wasSel ? null : state.selectedAiTestId };
    }

    case 'AI_TESTS_CLEARED':
      return { ...state, aiTests: [], selectedAiTestId: null };

    case 'AI_TEST_SELECTED':
      // Opening an AI test closes any open report.
      return {
        ...state,
        selectedAiTestId: payload.id,
        selectedReportId: null,
        selectedReportElements: null,
      };

    case 'AI_TEST_CLOSED':
      return { ...state, selectedAiTestId: null };

    // ---- record session ----
    case 'RECORD_STARTING':
      return {
        ...state,
        recordPhase: 'starting',
        recordSection: payload.section ?? state.section,
        liveCounts: { click: 0, input: 0, form: 0, navigation: 0, scroll: 0, scan: 0, elements: 0 },
      };

    case 'RECORD_STARTED':
      return { ...state, recordPhase: 'recording', recordSessionId: payload.sessionId ?? null };

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
    case 'RECORD_FAILED':
      return { ...state, recordPhase: 'idle', recordSessionId: null, recordSection: null };

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
      return { ...state, scanPhase: 'idle', scanProgress: { label: '', pct: 0 }, operationId: null };

    case 'SCAN_ERROR':
      return { ...state, scanPhase: 'error', scanError: payload.error ?? 'Scan failed', operationId: null };

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
