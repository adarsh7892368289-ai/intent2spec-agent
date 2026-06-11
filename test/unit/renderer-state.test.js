import { describe, it, expect, vi, beforeEach } from 'vitest';

// state.js is a singleton container (module-level `_state` + a `_listeners`
// Set). To keep tests isolated we reset the module registry before each test
// and re-import a fresh copy, so every test starts from `initialState` with no
// leftover listeners.
let state;

beforeEach(async () => {
  vi.resetModules();
  state = await import('../../src/renderer/state.js');
});

describe('state.js — exported constants', () => {
  it('TRACKING_MODES enumerates interactions / full_page / hybrid', () => {
    expect(state.TRACKING_MODES).toEqual({
      INTERACTIONS: 'interactions',
      FULL_PAGE: 'full_page',
      HYBRID: 'hybrid',
    });
  });

  it('SECTIONS enumerates interactions / scan / hybrid', () => {
    expect(state.SECTIONS).toEqual({
      INTERACTIONS: 'interactions',
      SCAN: 'scan',
      HYBRID: 'hybrid',
    });
  });

  it('DEFAULT_SETTINGS has the six capture toggles with passwords off by default', () => {
    expect(state.DEFAULT_SETTINGS).toEqual({
      captureClicks: true,
      captureInputs: true,
      captureForms: true,
      captureNavigation: true,
      captureScroll: true,
      capturePasswordFields: false,
    });
  });
});

describe('state.js — initial state shape', () => {
  it('starts on the interactions section / reports tab with empty collections', () => {
    const s = state.getState();
    expect(s.section).toBe('interactions');
    expect(s.leftTab).toBe('reports');
    expect(s.reports).toEqual([]);
    expect(s.selectedReportId).toBeNull();
    expect(s.selectedReportElements).toBeNull();
    expect(s.aiTests).toEqual([]);
    expect(s.selectedAiTestId).toBeNull();
  });

  it('seeds settings from a *copy* of DEFAULT_SETTINGS (not the same reference)', () => {
    const s = state.getState();
    expect(s.settings).toEqual(state.DEFAULT_SETTINGS);
    expect(s.settings).not.toBe(state.DEFAULT_SETTINGS);
  });

  it('starts idle for record + scan + browser detection with zeroed live counts', () => {
    const s = state.getState();
    expect(s.recordPhase).toBe('idle');
    expect(s.recordSessionId).toBeNull();
    expect(s.recordSection).toBeNull();
    expect(s.liveCounts).toEqual({
      click: 0,
      input: 0,
      form: 0,
      navigation: 0,
      scroll: 0,
      scan: 0,
      elements: 0,
    });
    expect(s.scanPhase).toBe('idle');
    expect(s.scanProgress).toEqual({ label: '', pct: 0 });
    expect(s.scanError).toBeNull();
    expect(s.operationId).toBeNull();
    expect(s.browserDetectionState).toBe('idle');
    expect(s.availableBrowsers).toEqual([]);
    expect(s.selectedBrowser).toBeNull();
    expect(s.usage).toEqual({ usage: 0, quota: 0 });
  });
});

describe('state.js — section / tab / settings actions', () => {
  it('SECTION_CHANGED replaces the active section', () => {
    state.dispatch('SECTION_CHANGED', { section: 'scan' });
    expect(state.getState().section).toBe('scan');
  });

  it('SECTION_CHANGED passes arbitrary values through unchanged (no validation)', () => {
    state.dispatch('SECTION_CHANGED', { section: 'not-a-real-section' });
    expect(state.getState().section).toBe('not-a-real-section');
  });

  it('LEFT_TAB_CHANGED switches the left-pane tab', () => {
    state.dispatch('LEFT_TAB_CHANGED', { tab: 'ai' });
    expect(state.getState().leftTab).toBe('ai');
  });

  it('SETTING_TOGGLED merges a single key without disturbing the others', () => {
    state.dispatch('SETTING_TOGGLED', { key: 'captureClicks', value: false });
    const s = state.getState();
    expect(s.settings.captureClicks).toBe(false);
    expect(s.settings.captureInputs).toBe(true);
    expect(s.settings.capturePasswordFields).toBe(false);
  });

  it('SETTING_TOGGLED can enable a previously-off toggle', () => {
    state.dispatch('SETTING_TOGGLED', { key: 'capturePasswordFields', value: true });
    expect(state.getState().settings.capturePasswordFields).toBe(true);
  });

  it('SETTINGS_LOADED overlays the payload onto DEFAULT_SETTINGS', () => {
    state.dispatch('SETTINGS_LOADED', { settings: { captureScroll: false } });
    const s = state.getState();
    expect(s.settings.captureScroll).toBe(false);
    expect(s.settings.captureClicks).toBe(true); // from defaults
  });

  it('SETTINGS_LOADED with no payload resets to DEFAULT_SETTINGS', () => {
    state.dispatch('SETTING_TOGGLED', { key: 'captureClicks', value: false });
    state.dispatch('SETTINGS_LOADED', {});
    expect(state.getState().settings).toEqual(state.DEFAULT_SETTINGS);
  });

  it('USAGE_LOADED stores the usage payload and falls back to prior usage when missing', () => {
    state.dispatch('USAGE_LOADED', { usage: { usage: 10, quota: 100 } });
    expect(state.getState().usage).toEqual({ usage: 10, quota: 100 });
    state.dispatch('USAGE_LOADED', {});
    expect(state.getState().usage).toEqual({ usage: 10, quota: 100 });
  });
});

describe('state.js — reports', () => {
  it('REPORTS_LOADED replaces the list and defaults to [] when missing', () => {
    state.dispatch('REPORTS_LOADED', { reports: [{ id: 'r1' }] });
    expect(state.getState().reports).toEqual([{ id: 'r1' }]);
    state.dispatch('REPORTS_LOADED', {});
    expect(state.getState().reports).toEqual([]);
  });

  it('REPORT_ADDED prepends and dedupes by id (newest first)', () => {
    state.dispatch('REPORT_ADDED', { report: { id: 'a', n: 1 } });
    state.dispatch('REPORT_ADDED', { report: { id: 'b', n: 2 } });
    expect(state.getState().reports.map((r) => r.id)).toEqual(['b', 'a']);

    // Re-adding 'a' moves it to the front and removes the stale copy.
    state.dispatch('REPORT_ADDED', { report: { id: 'a', n: 99 } });
    const reports = state.getState().reports;
    expect(reports.map((r) => r.id)).toEqual(['a', 'b']);
    expect(reports.find((r) => r.id === 'a').n).toBe(99);
    expect(reports.filter((r) => r.id === 'a')).toHaveLength(1);
  });

  it('REPORT_DELETED removes the report and clears selection only when it was selected', () => {
    state.dispatch('REPORTS_LOADED', { reports: [{ id: 'a' }, { id: 'b' }] });
    state.dispatch('REPORT_SELECTED', { reportId: 'a' });
    state.dispatch('REPORT_ELEMENTS_LOADED', { reportId: 'a', elements: [{ id: 'e' }] });

    // Deleting the *unselected* report keeps the selection intact.
    state.dispatch('REPORT_DELETED', { reportId: 'b' });
    let s = state.getState();
    expect(s.reports.map((r) => r.id)).toEqual(['a']);
    expect(s.selectedReportId).toBe('a');
    expect(s.selectedReportElements).toEqual([{ id: 'e' }]);

    // Deleting the *selected* report clears selection + elements.
    state.dispatch('REPORT_DELETED', { reportId: 'a' });
    s = state.getState();
    expect(s.reports).toEqual([]);
    expect(s.selectedReportId).toBeNull();
    expect(s.selectedReportElements).toBeNull();
  });

  it('REPORTS_CLEARED empties the list and clears any selection', () => {
    state.dispatch('REPORTS_LOADED', { reports: [{ id: 'a' }] });
    state.dispatch('REPORT_SELECTED', { reportId: 'a' });
    state.dispatch('REPORTS_CLEARED');
    const s = state.getState();
    expect(s.reports).toEqual([]);
    expect(s.selectedReportId).toBeNull();
    expect(s.selectedReportElements).toBeNull();
  });

  it('REPORT_SELECTED sets the report and closes any open AI test (one pane at a time)', () => {
    state.dispatch('AI_TEST_SELECTED', { id: 'ai1' });
    expect(state.getState().selectedAiTestId).toBe('ai1');

    state.dispatch('REPORT_SELECTED', { reportId: 'r1' });
    const s = state.getState();
    expect(s.selectedReportId).toBe('r1');
    expect(s.selectedReportElements).toBeNull();
    expect(s.selectedAiTestId).toBeNull();
  });

  it('REPORT_ELEMENTS_LOADED stores elements for the currently-selected report', () => {
    state.dispatch('REPORT_SELECTED', { reportId: 'r1' });
    state.dispatch('REPORT_ELEMENTS_LOADED', { reportId: 'r1', elements: [{ id: 'e1' }] });
    expect(state.getState().selectedReportElements).toEqual([{ id: 'e1' }]);
  });

  it('REPORT_ELEMENTS_LOADED defaults to [] when elements payload is missing', () => {
    state.dispatch('REPORT_SELECTED', { reportId: 'r1' });
    state.dispatch('REPORT_ELEMENTS_LOADED', { reportId: 'r1' });
    expect(state.getState().selectedReportElements).toEqual([]);
  });

  it('REPORT_ELEMENTS_LOADED is ignored when the payload reportId is stale', () => {
    state.dispatch('REPORT_SELECTED', { reportId: 'r1' });
    const before = state.getState();
    state.dispatch('REPORT_ELEMENTS_LOADED', { reportId: 'OTHER', elements: [{ id: 'x' }] });
    // No-op: returns the exact same state object, selection untouched.
    expect(state.getState()).toBe(before);
    expect(state.getState().selectedReportElements).toBeNull();
  });

  it('REPORT_CLOSED clears the open report without touching the list', () => {
    state.dispatch('REPORTS_LOADED', { reports: [{ id: 'r1' }] });
    state.dispatch('REPORT_SELECTED', { reportId: 'r1' });
    state.dispatch('REPORT_ELEMENTS_LOADED', { reportId: 'r1', elements: [{ id: 'e' }] });
    state.dispatch('REPORT_CLOSED');
    const s = state.getState();
    expect(s.selectedReportId).toBeNull();
    expect(s.selectedReportElements).toBeNull();
    expect(s.reports).toEqual([{ id: 'r1' }]);
  });
});

describe('state.js — AI tests', () => {
  it('AI_TESTS_LOADED replaces the list and defaults to [] when missing', () => {
    state.dispatch('AI_TESTS_LOADED', { aiTests: [{ id: 't1' }] });
    expect(state.getState().aiTests).toEqual([{ id: 't1' }]);
    state.dispatch('AI_TESTS_LOADED', {});
    expect(state.getState().aiTests).toEqual([]);
  });

  it('AI_TEST_SELECTED sets the test and closes any open report (one pane at a time)', () => {
    state.dispatch('REPORT_SELECTED', { reportId: 'r1' });
    state.dispatch('AI_TEST_SELECTED', { id: 't1' });
    const s = state.getState();
    expect(s.selectedAiTestId).toBe('t1');
    expect(s.selectedReportId).toBeNull();
    expect(s.selectedReportElements).toBeNull();
  });

  it('AI_TEST_DELETED removes the test and clears selection only when it was selected', () => {
    state.dispatch('AI_TESTS_LOADED', { aiTests: [{ id: 't1' }, { id: 't2' }] });
    state.dispatch('AI_TEST_SELECTED', { id: 't1' });

    // Deleting an unselected test keeps selection.
    state.dispatch('AI_TEST_DELETED', { id: 't2' });
    let s = state.getState();
    expect(s.aiTests.map((t) => t.id)).toEqual(['t1']);
    expect(s.selectedAiTestId).toBe('t1');

    // Deleting the selected test clears selection.
    state.dispatch('AI_TEST_DELETED', { id: 't1' });
    s = state.getState();
    expect(s.aiTests).toEqual([]);
    expect(s.selectedAiTestId).toBeNull();
  });

  it('AI_TESTS_CLEARED empties the list and clears selection', () => {
    state.dispatch('AI_TESTS_LOADED', { aiTests: [{ id: 't1' }] });
    state.dispatch('AI_TEST_SELECTED', { id: 't1' });
    state.dispatch('AI_TESTS_CLEARED');
    const s = state.getState();
    expect(s.aiTests).toEqual([]);
    expect(s.selectedAiTestId).toBeNull();
  });

  it('AI_TEST_CLOSED clears the open test only', () => {
    state.dispatch('AI_TEST_SELECTED', { id: 't1' });
    state.dispatch('AI_TEST_CLOSED');
    expect(state.getState().selectedAiTestId).toBeNull();
  });
});

describe('state.js — record session', () => {
  it('RECORD_STARTING enters the starting phase, records the section, and zeroes live counts', () => {
    // Dirty the counts first so we can prove they get reset.
    state.dispatch('RECORD_EVENT', { captureType: 'click' });
    state.dispatch('RECORD_STARTING', { section: 'scan' });
    const s = state.getState();
    expect(s.recordPhase).toBe('starting');
    expect(s.recordSection).toBe('scan');
    expect(s.liveCounts).toEqual({
      click: 0,
      input: 0,
      form: 0,
      navigation: 0,
      scroll: 0,
      scan: 0,
      elements: 0,
    });
  });

  it('RECORD_STARTING falls back to the active section when none is supplied', () => {
    state.dispatch('SECTION_CHANGED', { section: 'hybrid' });
    state.dispatch('RECORD_STARTING', {});
    expect(state.getState().recordSection).toBe('hybrid');
  });

  it('RECORD_STARTED transitions to recording and stores the session id', () => {
    state.dispatch('RECORD_STARTING', { section: 'interactions' });
    state.dispatch('RECORD_STARTED', { sessionId: 'sess-1' });
    const s = state.getState();
    expect(s.recordPhase).toBe('recording');
    expect(s.recordSessionId).toBe('sess-1');
  });

  it('RECORD_EVENT increments only the matching live counter', () => {
    state.dispatch('RECORD_EVENT', { captureType: 'click' });
    state.dispatch('RECORD_EVENT', { captureType: 'click' });
    state.dispatch('RECORD_EVENT', { captureType: 'input' });
    const s = state.getState();
    expect(s.liveCounts.click).toBe(2);
    expect(s.liveCounts.input).toBe(1);
    expect(s.liveCounts.form).toBe(0);
  });

  it('RECORD_EVENT ignores unknown capture types and a missing captureType', () => {
    const before = state.getState().liveCounts;
    state.dispatch('RECORD_EVENT', { captureType: 'bogus' });
    state.dispatch('RECORD_EVENT', {});
    expect(state.getState().liveCounts).toEqual(before);
  });

  it('RECORD_SCAN bumps the scan counter and accumulates element counts', () => {
    state.dispatch('RECORD_SCAN', { elementCount: 5 });
    state.dispatch('RECORD_SCAN', { elementCount: 3 });
    const s = state.getState();
    expect(s.liveCounts.scan).toBe(2);
    expect(s.liveCounts.elements).toBe(8);
  });

  it('RECORD_SCAN treats a missing elementCount as zero', () => {
    state.dispatch('RECORD_SCAN', {});
    const s = state.getState();
    expect(s.liveCounts.scan).toBe(1);
    expect(s.liveCounts.elements).toBe(0);
  });

  it('RECORD_STOPPED returns the session to idle and clears session metadata', () => {
    state.dispatch('RECORD_STARTING', { section: 'scan' });
    state.dispatch('RECORD_STARTED', { sessionId: 'sess-1' });
    state.dispatch('RECORD_STOPPED');
    const s = state.getState();
    expect(s.recordPhase).toBe('idle');
    expect(s.recordSessionId).toBeNull();
    expect(s.recordSection).toBeNull();
  });

  it('RECORD_FAILED resets the session exactly like RECORD_STOPPED', () => {
    state.dispatch('RECORD_STARTING', { section: 'scan' });
    state.dispatch('RECORD_STARTED', { sessionId: 'sess-1' });
    state.dispatch('RECORD_FAILED');
    const s = state.getState();
    expect(s.recordPhase).toBe('idle');
    expect(s.recordSessionId).toBeNull();
    expect(s.recordSection).toBeNull();
  });
});

describe('state.js — scan lifecycle', () => {
  it('SCAN_STARTED enters scanning with progress + operationId and clears prior error', () => {
    state.dispatch('SCAN_ERROR', { error: 'old failure' });
    state.dispatch('SCAN_STARTED', { label: 'Loading', pct: 10, operationId: 'op-1' });
    const s = state.getState();
    expect(s.scanPhase).toBe('scanning');
    expect(s.scanProgress).toEqual({ label: 'Loading', pct: 10 });
    expect(s.operationId).toBe('op-1');
    expect(s.scanError).toBeNull();
  });

  it('SCAN_STARTED defaults label / pct / operationId when omitted', () => {
    state.dispatch('SCAN_STARTED', {});
    const s = state.getState();
    expect(s.scanProgress).toEqual({ label: 'Starting…', pct: 0 });
    expect(s.operationId).toBeNull();
  });

  it('SCAN_PROGRESS updates progress only while scanning', () => {
    state.dispatch('SCAN_STARTED', { label: 'a', pct: 0, operationId: 'op-1' });
    state.dispatch('SCAN_PROGRESS', { label: 'half', pct: 50 });
    expect(state.getState().scanProgress).toEqual({ label: 'half', pct: 50 });
  });

  it('SCAN_PROGRESS is a no-op when not scanning (idle phase)', () => {
    const before = state.getState();
    expect(before.scanPhase).toBe('idle');
    state.dispatch('SCAN_PROGRESS', { label: 'ignored', pct: 99 });
    expect(state.getState()).toBe(before);
    expect(state.getState().scanProgress).toEqual({ label: '', pct: 0 });
  });

  it('SCAN_DONE returns to idle and resets progress + operationId', () => {
    state.dispatch('SCAN_STARTED', { label: 'a', pct: 30, operationId: 'op-1' });
    state.dispatch('SCAN_DONE');
    const s = state.getState();
    expect(s.scanPhase).toBe('idle');
    expect(s.scanProgress).toEqual({ label: '', pct: 0 });
    expect(s.operationId).toBeNull();
  });

  it('SCAN_ERROR enters the error phase with the message and clears operationId', () => {
    state.dispatch('SCAN_STARTED', { label: 'a', pct: 30, operationId: 'op-1' });
    state.dispatch('SCAN_ERROR', { error: 'boom' });
    const s = state.getState();
    expect(s.scanPhase).toBe('error');
    expect(s.scanError).toBe('boom');
    expect(s.operationId).toBeNull();
  });

  it('SCAN_ERROR falls back to a default message when none provided', () => {
    state.dispatch('SCAN_ERROR', {});
    expect(state.getState().scanError).toBe('Scan failed');
  });

  it('SCAN_RESET clears the error phase back to idle', () => {
    state.dispatch('SCAN_ERROR', { error: 'boom' });
    state.dispatch('SCAN_RESET');
    const s = state.getState();
    expect(s.scanPhase).toBe('idle');
    expect(s.scanProgress).toEqual({ label: '', pct: 0 });
    expect(s.scanError).toBeNull();
  });
});

describe('state.js — browser detection', () => {
  it('BROWSER_DETECTION_STARTED enters loading and clears prior error', () => {
    state.dispatch('BROWSER_DETECTION_FAILED', { error: 'nope' });
    state.dispatch('BROWSER_DETECTION_STARTED');
    const s = state.getState();
    expect(s.browserDetectionState).toBe('loading');
    expect(s.browserDetectionError).toBeNull();
  });

  it('BROWSERS_DETECTED auto-selects the launchable default browser first', () => {
    const browsers = [
      { id: 'ff', isLaunchable: true, isDefault: false },
      { id: 'chrome', isLaunchable: true, isDefault: true },
    ];
    state.dispatch('BROWSERS_DETECTED', { browsers });
    const s = state.getState();
    expect(s.browserDetectionState).toBe('ready');
    expect(s.availableBrowsers).toBe(browsers);
    expect(s.selectedBrowser.id).toBe('chrome');
  });

  it('BROWSERS_DETECTED falls back to the first launchable when no default is launchable', () => {
    const browsers = [
      { id: 'default-but-unlaunchable', isLaunchable: false, isDefault: true },
      { id: 'usable', isLaunchable: true, isDefault: false },
    ];
    state.dispatch('BROWSERS_DETECTED', { browsers });
    expect(state.getState().selectedBrowser.id).toBe('usable');
  });

  it('BROWSERS_DETECTED leaves selectedBrowser null when nothing is launchable', () => {
    const browsers = [{ id: 'x', isLaunchable: false, isDefault: true }];
    state.dispatch('BROWSERS_DETECTED', { browsers });
    expect(state.getState().selectedBrowser).toBeNull();
  });

  it('BROWSERS_DETECTED preserves an already-chosen browser instead of re-selecting', () => {
    state.dispatch('BROWSER_SELECTED', { browser: { id: 'pinned' } });
    state.dispatch('BROWSERS_DETECTED', {
      browsers: [{ id: 'chrome', isLaunchable: true, isDefault: true }],
    });
    expect(state.getState().selectedBrowser.id).toBe('pinned');
  });

  it('BROWSER_DETECTION_FAILED records the error message (with a default fallback)', () => {
    state.dispatch('BROWSER_DETECTION_FAILED', { error: 'spawn EACCES' });
    let s = state.getState();
    expect(s.browserDetectionState).toBe('error');
    expect(s.browserDetectionError).toBe('spawn EACCES');

    state.dispatch('BROWSER_DETECTION_FAILED', {});
    expect(state.getState().browserDetectionError).toBe('Browser detection failed');
  });

  it('BROWSER_SELECTED stores the chosen browser and tolerates a missing payload', () => {
    state.dispatch('BROWSER_SELECTED', { browser: { id: 'webkit' } });
    expect(state.getState().selectedBrowser).toEqual({ id: 'webkit' });
    state.dispatch('BROWSER_SELECTED', {});
    expect(state.getState().selectedBrowser).toBeNull();
  });
});

describe('state.js — dispatch / reduce semantics', () => {
  it('an unknown action type is a no-op (returns the same state reference)', () => {
    const before = state.getState();
    state.dispatch('THIS_ACTION_DOES_NOT_EXIST', { whatever: true });
    expect(state.getState()).toBe(before);
  });

  it('dispatch works with no payload argument (defaults to {})', () => {
    // RECORD_STOPPED reads no payload fields, so the default {} must not throw.
    expect(() => state.dispatch('RECORD_STOPPED')).not.toThrow();
    expect(state.getState().recordPhase).toBe('idle');
  });

  it('each dispatch produces a new top-level state object (immutability)', () => {
    const before = state.getState();
    state.dispatch('SECTION_CHANGED', { section: 'scan' });
    expect(state.getState()).not.toBe(before);
    // Original snapshot is untouched (reducers spread into a fresh object).
    expect(before.section).toBe('interactions');
  });
});

describe('state.js — subscribe / unsubscribe', () => {
  it('subscribe fires the listener with the new state on every dispatch', () => {
    const listener = vi.fn();
    state.subscribe(listener);
    state.dispatch('SECTION_CHANGED', { section: 'scan' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(state.getState());
    state.dispatch('LEFT_TAB_CHANGED', { tab: 'ai' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('subscribe fires even for no-op (unknown) actions', () => {
    const listener = vi.fn();
    state.subscribe(listener);
    state.dispatch('UNKNOWN_NOOP');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe function stops further notifications', () => {
    const listener = vi.fn();
    const unsubscribe = state.subscribe(listener);
    state.dispatch('SECTION_CHANGED', { section: 'scan' });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    state.dispatch('SECTION_CHANGED', { section: 'hybrid' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies multiple listeners, and one throwing does not break the others', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good1 = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('listener kaboom');
    });
    const good2 = vi.fn();
    state.subscribe(good1);
    state.subscribe(bad);
    state.subscribe(good2);

    expect(() => state.dispatch('SECTION_CHANGED', { section: 'scan' })).not.toThrow();
    expect(good1).toHaveBeenCalledTimes(1);
    expect(good2).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('subscribing the same listener twice still registers it once (Set semantics)', () => {
    const listener = vi.fn();
    state.subscribe(listener);
    state.subscribe(listener);
    state.dispatch('SECTION_CHANGED', { section: 'scan' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('state.js — getState snapshot characteristics', () => {
  // The surface-map brief describes getState() as returning a "frozen snapshot".
  // The real implementation returns the live `_state` object directly (no
  // Object.freeze). We assert the ACTUAL contract here so the suite documents
  // real behavior rather than an aspirational one.
  it('returns the same reference until the next dispatch swaps it', () => {
    const a = state.getState();
    const b = state.getState();
    expect(a).toBe(b);
    state.dispatch('SECTION_CHANGED', { section: 'scan' });
    expect(state.getState()).not.toBe(a);
  });

  it('does NOT freeze the returned state object (matches the implementation, not the brief)', () => {
    const s = state.getState();
    expect(Object.isFrozen(s)).toBe(false);
  });
});
