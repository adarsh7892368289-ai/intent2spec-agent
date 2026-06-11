'use strict';

const log = require('electron-log');

const { assertHttpUrl } = require('@security/guards.js');
const { getBrowser, getTrackerBundleSource } = require('./playwright-manager');

// A Record session drives a real, HEADED browser the user operates by hand.
// The tracker bundle is injected via addInitScript so it survives navigations;
// captured interactions/scans stream back through the exposeBinding '__etEmit'.
// Only one session is active at a time (single-window product model).

let _session = null;
// Set synchronously at the top of startRecordSession so two near-simultaneous
// starts can't both pass the guard and each create a context (the first leaks).
let _starting = false;

// Build the page-side init script: the UMD bundle followed by a startCapture
// call. addInitScript runs this on every navigation / new document in the
// context, so capture re-arms automatically as the user browses.
function _buildInitScript(mode, settings, sessionId, profiles) {
  const bundle = getTrackerBundleSource();
  const cfg = JSON.stringify({ mode, settings: settings ?? {}, sessionId, profiles: profiles ?? {} });
  return `${bundle}
;(function () {
  try {
    var cfg = ${cfg};
    var api = window.__elementTracker;
    if (!api) { return; }
    api.startCapture(cfg.mode, Object.assign({}, cfg.settings, {
      sessionId: cfg.sessionId,
      profiles: cfg.profiles
    }));
  } catch (e) {
    console.error('[record-init] startCapture failed', e);
  }
})();`;
}

async function startRecordSession({
  url,
  mode,
  settings,
  profiles,
  sessionId,
  browser: browserDescriptor,
  onEvent,
  onScan,
  onClosed,
}) {
  assertHttpUrl(url, 'Record URL');

  if (_starting) {
    throw Object.assign(new Error('A record session is already starting.'), { code: 'RECORD_BUSY' });
  }
  _starting = true;

  const effectiveMode = mode || 'interactions';
  const effectiveSessionId = sessionId || `rec_${Date.now()}`;
  const launchTarget = browserDescriptor ?? 'chromium';
  let context = null;

  // Any failure between context creation and a fully-initialized session must
  // close the context — otherwise it leaks inside the cached headed browser.
  try {
    if (_session) {
      await stopRecordSession().catch(() => {});
    }

    // Headed launch so the human can drive the page.
    const browser = await getBrowser({ ..._descriptor(launchTarget), headed: true });

    context = await browser.newContext({ viewport: null });

    const session = {
      sessionId: effectiveSessionId,
      mode: effectiveMode,
      context,
      page: null,
      closed: false,
      onClosed,
    };
    _session = session;

    // Outbound transport from page → main. The page calls window.__etEmit({channel, payload}).
    await context.exposeBinding('__etEmit', (source, message) => {
      if (session.closed || !message || typeof message !== 'object') {
        return;
      }
      const { channel, payload } = message;
      try {
        if (channel === 'interaction') {
          onEvent?.(payload);
        } else if (channel === 'scan') {
          onScan?.(payload);
        }
      } catch (err) {
        log.warn('[RecordManager] event dispatch failed', { error: err?.message });
      }
    });

    await context.addInitScript({
      content: _buildInitScript(effectiveMode, settings, effectiveSessionId, profiles),
    });

    const page = await context.newPage();
    session.page = page;

    // If the user closes the browser window/tab manually, tear down + notify.
    context.on('close', () => _handleContextClosed(session));
    page.on('close', () => {
      if (context.pages().length === 0) {
        _handleContextClosed(session);
      }
    });

    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.bringToFront().catch(() => {});

    log.info('[RecordManager] session started', {
      sessionId: effectiveSessionId,
      mode: effectiveMode,
      url,
    });

    return { sessionId: effectiveSessionId, mode: effectiveMode };
  } catch (err) {
    log.error('[RecordManager] session start failed — cleaning up', { error: err?.message });
    _session = null;
    if (context) {
      await context.close().catch(() => {});
    }
    throw err;
  } finally {
    _starting = false;
  }
}

function _descriptor(descriptorOrType) {
  if (typeof descriptorOrType === 'string') {
    return { browserType: descriptorOrType, channel: null, executablePath: null };
  }
  return descriptorOrType ?? { browserType: 'chromium', channel: null, executablePath: null };
}

function _handleContextClosed(session) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  if (_session === session) {
    _session = null;
  }
  log.info('[RecordManager] session context closed', { sessionId: session.sessionId });
  try {
    session.onClosed?.({ sessionId: session.sessionId });
  } catch {
    void 0;
  }
}

// Hybrid on-demand scan: run triggerScan in the live page and stream the result
// out as a 'scan' event (it also fires page-scan-completed internally).
async function triggerRecordScan({ filters } = {}) {
  if (!_session || !_session.page || _session.closed) {
    return { success: false, error: 'No active record session' };
  }
  try {
    const list = Array.isArray(filters) ? filters : filters ? [filters] : [];
    await _session.page.evaluate((f) => window.__elementTracker.triggerScan(f), list);
    return { success: true };
  } catch (err) {
    log.warn('[RecordManager] triggerScan failed', { error: err?.message });
    return { success: false, error: err?.message };
  }
}

// Stop the session, harvesting any attribute profiles learned during it so the
// renderer can persist them.
async function stopRecordSession() {
  const session = _session;
  if (!session) {
    return { success: true, profiles: {} };
  }

  let profiles = {};
  try {
    if (session.page && !session.closed) {
      profiles = await session.page
        .evaluate(() => (window.__elementTracker ? window.__elementTracker.exportProfiles() : {}))
        .catch((err) => {
          log.warn('[RecordManager] exportProfiles failed', { error: err?.message });
          return {};
        });
    }
  } catch (err) {
    log.warn('[RecordManager] exportProfiles threw', { error: err?.message });
    profiles = {};
  }

  session.closed = true;
  _session = null;

  try {
    await session.context.close();
  } catch (err) {
    log.warn('[RecordManager] context close failed', { error: err?.message });
  }

  log.info('[RecordManager] session stopped', { sessionId: session.sessionId });
  return { success: true, profiles, sessionId: session.sessionId };
}

function hasActiveSession() {
  return !!_session && !_session.closed;
}

module.exports = {
  startRecordSession,
  stopRecordSession,
  triggerRecordScan,
  hasActiveSession,
};
