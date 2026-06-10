// =============================================================================
// Page Entry: UMD bundle surface injected into Playwright-controlled pages.
//
// Replaces the Chrome-extension content bootstrap (injector.js) and the
// chrome-coupled half of event-manager.js. Pure DOM — no chrome.*, no Node.
//
//   window.__elementTracker = {
//     scanPage(filters, options)       -> Promise<scanData>   (automated Element Scan)
//     startCapture(mode, settings)     -> { ok }              (headed Record session)
//     stopCapture()                    -> { ok }
//     triggerScan(filters)             -> Promise<scanData>   (Hybrid on-demand scan)
//     seedProfiles(profiles) / exportProfiles()               (attribute-profiler bridge)
//   }
//
// Outbound transport: captured interactions and scans are forwarded to
// window.__etEmit(payload) — a Playwright exposeBinding installed by the main
// process (Phase 5). When __etEmit is absent (automated scan path), scanPage
// simply returns its result as the page.evaluate() value.
// =============================================================================

import PageScanner from './capture/page-scanner.js';
import ClickCapture from './capture/click-capture.js';
import FormCapture from './capture/form-capture.js';
import InputCapture from './capture/input-capture.js';
import NavigationCapture from './capture/navigation-capture.js';
import ScrollCapture from './capture/scroll-capture.js';
import AttributeProfiler from './shared/attribute-profiler.js';
import XPathEngine from './enrichment/xpath-engine.js';
import { DEFAULT_SETTINGS, TRACKING_MODES } from './shared/config.js';
import { clearPageContextCache } from './helpers/enrichment-utils.js';

const GUARD = '__elementTrackerPageInit';

// ---- module state (per page/frame) -----------------------------------------
const state = {
  mode: TRACKING_MODES.INTERACTIONS,
  settings: { ...DEFAULT_SETTINGS },
  sessionId: 'sess_unknown',
  capturing: false,
  modules: [],
  listenersBound: false,
  interactionHandler: null,
  scanHandler: null,
};

function domain() {
  try {
    return new URL(window.location.href).hostname;
  } catch {
    return 'unknown';
  }
}

function emit(channel, payload) {
  // exposeBinding delivers a single arg; wrap channel + data together.
  if (typeof window.__etEmit === 'function') {
    try {
      window.__etEmit({ channel, payload });
    } catch (err) {
      console.error('[page-entry] __etEmit failed', err);
    }
  }
}

// Bridge the capture modules' window CustomEvents to the outbound transport.
// Capture modules dispatch 'interaction-captured' and 'page-scan-completed';
// in the extension these were aggregated by event-manager and sent to the
// background. Here we forward them to the host via __etEmit.
function bindCaptureListeners() {
  if (state.listenersBound) {
    return;
  }

  state.interactionHandler = (event) => {
    if (!state.capturing) {
      return;
    }
    const data = event.detail?.data;
    if (data) {
      emit('interaction', { mode: state.mode, sessionId: state.sessionId, element: data });
    }
  };

  state.scanHandler = (event) => {
    if (!state.capturing) {
      return;
    }
    const scan = event.detail;
    if (scan) {
      emit('scan', { mode: state.mode, sessionId: state.sessionId, scan });
    }
  };

  window.addEventListener('interaction-captured', state.interactionHandler);
  window.addEventListener('page-scan-completed', state.scanHandler);
  state.listenersBound = true;
}

function unbindCaptureListeners() {
  if (!state.listenersBound) {
    return;
  }
  if (state.interactionHandler) {
    window.removeEventListener('interaction-captured', state.interactionHandler);
  }
  if (state.scanHandler) {
    window.removeEventListener('page-scan-completed', state.scanHandler);
  }
  state.interactionHandler = null;
  state.scanHandler = null;
  state.listenersBound = false;
}

function setGlobals() {
  window.__trackerSessionId = state.sessionId;
  window.__trackerMode = state.mode;
  window.__trackerActive = state.capturing;
  window.__isTracking = state.capturing;
}

function destroyModules() {
  for (const mod of state.modules) {
    try {
      mod?.destroy?.();
    } catch (err) {
      console.warn('[page-entry] module destroy failed', err);
    }
  }
  state.modules = [];
}

// Mirrors event-manager.initializeCaptureModulesForMode, honoring capture-type
// settings. Scroll/click/etc. only stream while state.capturing is true.
function buildModulesForMode(mode) {
  const s = state.settings;
  const modules = [];
  const wantInteractions = mode === TRACKING_MODES.INTERACTIONS || mode === TRACKING_MODES.HYBRID;

  if (wantInteractions) {
    if (s.captureClicks !== false) {
      modules.push(new ClickCapture(mode));
    }
    if (s.captureInputs !== false) {
      modules.push(new InputCapture(mode));
    }
    if (s.captureNavigation !== false) {
      modules.push(new NavigationCapture(mode));
    }
    if (s.captureForms !== false) {
      modules.push(new FormCapture(mode));
    }
    if (s.captureScroll !== false) {
      modules.push(new ScrollCapture(mode));
    }
  }

  if (mode === TRACKING_MODES.FULL_PAGE || mode === TRACKING_MODES.HYBRID) {
    modules.push(new PageScanner());
  }

  for (const mod of modules) {
    try {
      mod.init?.();
    } catch (err) {
      console.warn('[page-entry] module init failed', err);
    }
  }
  return modules;
}

// Warm the per-domain XPath attribute cache (profiling the page first when it
// has enough interactive elements), exactly as event-manager.init did.
async function warmProfilingFor(d) {
  try {
    const interactiveCount = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [onclick], [data-testid], [data-test], [data-qa]'
    ).length;
    if (interactiveCount > 10) {
      await AttributeProfiler.profilePage(d);
    }
    await XPathEngine.warmCache(d);
  } catch (err) {
    console.warn('[page-entry] profiling/warm failed', err);
  }
}

// ---- public API -------------------------------------------------------------

// Automated full-page (or filtered) scan. Returns the scan-data object so the
// main process can read it as the page.evaluate() return value. Also harvests
// any attribute profile learned during this scan.
export async function scanPage(filters = null, options = {}) {
  const opts = options || {};
  state.mode = opts.mode || TRACKING_MODES.FULL_PAGE;
  state.settings = { ...DEFAULT_SETTINGS, ...(opts.settings || {}) };
  state.sessionId = opts.sessionId || 'sess_scan';
  if (opts.profiles) {
    AttributeProfiler.seedProfiles(opts.profiles);
  }
  setGlobals();

  const d = domain();
  await warmProfilingFor(d);

  const scanner = new PageScanner();
  scanner.init();
  const normalizedFilters = Array.isArray(filters) ? filters : filters ? [filters] : [];
  const scanData = await scanner.scanPage(normalizedFilters);
  scanner.destroy();

  return {
    scan: scanData,
    profiles: AttributeProfiler.exportProfiles(),
  };
}

// Begin a headed Record session. The host drives the browser; capture modules
// stream interactions out via __etEmit. Survives re-injection (addInitScript):
// the guard prevents double-binding when the bundle reruns on navigation.
export async function startCapture(mode = TRACKING_MODES.INTERACTIONS, settings = {}) {
  state.mode = mode || TRACKING_MODES.INTERACTIONS;
  state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  state.sessionId = (settings && settings.sessionId) || state.sessionId || 'sess_record';
  if (settings && settings.profiles) {
    AttributeProfiler.seedProfiles(settings.profiles);
  }

  destroyModules();
  state.capturing = true;
  setGlobals();
  bindCaptureListeners();

  const d = domain();
  await warmProfilingFor(d);

  state.modules = buildModulesForMode(state.mode);
  return { ok: true, mode: state.mode };
}

// Hybrid on-demand scan triggered from the renderer while a Record session is
// live. Uses the already-initialized PageScanner module if present.
export async function triggerScan(filters = []) {
  const scanner = state.modules.find((m) => m instanceof PageScanner);
  if (scanner) {
    return scanner.scanPage(Array.isArray(filters) ? filters : []);
  }
  const ad = new PageScanner();
  ad.init();
  const result = await ad.scanPage(Array.isArray(filters) ? filters : []);
  ad.destroy();
  return result;
}

export function stopCapture() {
  state.capturing = false;
  setGlobals();
  destroyModules();
  unbindCaptureListeners();
  try {
    clearPageContextCache();
  } catch {
    void 0;
  }
  return { ok: true };
}

export function seedProfiles(profiles) {
  AttributeProfiler.seedProfiles(profiles);
  return { ok: true };
}

export function exportProfiles() {
  return AttributeProfiler.exportProfiles();
}

// Idempotency marker so re-injection via addInitScript doesn't reset state.
if (!window[GUARD]) {
  window[GUARD] = true;
}
