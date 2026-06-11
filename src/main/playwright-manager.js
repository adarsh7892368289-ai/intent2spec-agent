'use strict';

const { chromium, firefox, webkit } = require('playwright');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');

const { mainDistributionDir } = require('./resource-paths');
const { assertHttpUrl, isBrowserDescriptorAllowed } = require('@security/guards.js');

// ---- extractor bundle source (cached) --------------------------------------

let _bundleSource = null;

function getTrackerBundleSource() {
  if (_bundleSource !== null) {
    return _bundleSource;
  }
  const distDir = mainDistributionDir();
  const candidates = [
    path.join(distDir, 'tracker-bundle.js'),
    path.join(__dirname, 'tracker-bundle.js'),
    path.join(process.cwd(), 'dist', 'tracker-bundle.js'),
  ];
  for (const candidate of candidates) {
    try {
      _bundleSource = fs.readFileSync(candidate, 'utf8');
      log.info('[PM] Loaded tracker bundle', { path: candidate });
      return _bundleSource;
    } catch {
      void 0;
    }
  }
  throw new Error(
    `Tracker bundle not found. Run: npm run build:bundle\nSearched:\n${candidates
      .map((c) => `  ${c}`)
      .join('\n')}`
  );
}

// ---- browser lifecycle ------------------------------------------------------

const _browsers = new Map();

// Upper bound for one in-page scanPage() evaluate. page.evaluate has no native
// timeout, so a pathological DOM could otherwise hang runScan indefinitely.
const SCAN_EVAL_TIMEOUT_MS = 45_000;

async function _assertDescriptorAllowed(browserType, channel, executablePath) {
  if (channel == null && executablePath == null) {
    return;
  }
  let detectBrowsers;
  try {
    ({ detectBrowsers } = require('./browser-detector'));
  } catch (err) {
    const denied = new Error('Browser detection unavailable — cannot validate the requested browser.');
    denied.code = 'BROWSER_NOT_FOUND';
    log.error('[PM] descriptor validation could not load detector', { error: err?.message });
    throw denied;
  }
  let detected;
  try {
    ({ browsers: detected } = await detectBrowsers({ refresh: false }));
  } catch (err) {
    const denied = new Error('Browser detection failed — cannot validate the requested browser.');
    denied.code = 'BROWSER_NOT_FOUND';
    log.error('[PM] descriptor validation detection failed', { error: err?.message });
    throw denied;
  }
  const match = isBrowserDescriptorAllowed({ browserType, channel, executablePath }, detected ?? []);
  if (!match) {
    log.warn('[PM] Rejected browser descriptor not in trusted detection set', {
      browserType,
      channel,
      executablePath,
    });
    const denied = new Error('Requested browser is not an available, launchable browser on this system.');
    denied.code = 'BROWSER_NOT_FOUND';
    throw denied;
  }
}

function _normalizeDescriptor(descriptorOrType) {
  if (typeof descriptorOrType === 'string') {
    return { browserType: descriptorOrType, channel: null, executablePath: null };
  }
  return descriptorOrType ?? { browserType: 'chromium', channel: null, executablePath: null };
}

// Launch (or reuse) a shared browser. Headless instances power automated scans;
// a separate headed instance (distinct cache key) drives Record sessions.
async function getBrowser(descriptorOrType = 'chromium') {
  const descriptor = _normalizeDescriptor(descriptorOrType);
  const browserType = descriptor.browserType ?? 'chromium';
  const channel = descriptor.channel ?? null;
  const executablePath = descriptor.executablePath ?? null;
  const headed = descriptor.headed === true;

  await _assertDescriptorAllowed(browserType, channel, executablePath);

  const cacheKey = `${browserType}:${channel ?? executablePath ?? 'managed'}:${headed ? 'headed' : 'headless'}`;
  const existing = _browsers.get(cacheKey);
  if (existing && existing.isConnected()) {
    return existing;
  }

  const launcher = { chromium, firefox, webkit }[browserType];
  if (!launcher) {
    throw new Error(`Unknown browserType: ${browserType}`);
  }

  const launchOptions = { headless: !headed };
  if (channel) {
    launchOptions.channel = channel;
  } else if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  log.info('[PM] Launching browser', { browserType, channel, executablePath, cacheKey });
  let browser;
  try {
    browser = await launcher.launch(launchOptions);
  } catch (err) {
    const msg = err?.message ?? String(err);
    const policyBlocked =
      /DevTools remote debugging is disallowed/i.test(msg) ||
      /remote.debugging.*disallowed/i.test(msg);
    if (policyBlocked) {
      const friendly = new Error(
        "This browser is blocked by your organisation's IT policy. Switch to Playwright Chromium in the browser selector."
      );
      friendly.code = 'BROWSER_POLICY_BLOCKED';
      throw friendly;
    }
    throw err;
  }
  // Evict the cache entry when the browser disconnects/crashes so we don't hand
  // out a dead handle or try to .close() it during shutdown.
  browser.on('disconnected', () => {
    if (_browsers.get(cacheKey) === browser) {
      _browsers.delete(cacheKey);
    }
  });
  _browsers.set(cacheKey, browser);
  return browser;
}

async function shutdownPlaywright() {
  const tasks = [];
  for (const [type, browser] of _browsers) {
    tasks.push(
      browser.close().catch((err) => log.warn('[PM] Browser close error', { type, err: err.message }))
    );
  }
  await Promise.allSettled(tasks);
  _browsers.clear();
  log.info('[PM] All browsers closed');
}

function _cancelErr() {
  return Object.assign(new Error('cancelled'), { code: 'CANCELLED', name: 'CancelledError' });
}

// Reject `promise` if it doesn't settle within `ms`. The in-page evaluate keeps
// running, but the caller's finally{} closes the page/context to free it.
function _withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

// ---- automated Element Scan -------------------------------------------------

// Navigate to a URL in a fresh, headless context, inject the tracker bundle,
// and run window.__elementTracker.scanPage. Returns the scan-data object plus
// any attribute profiles learned during the scan.
async function runScan({
  url,
  browser: browserDescriptor,
  filters,
  mode,
  settings,
  profiles,
  onProgress,
  isCancelled,
}) {
  assertHttpUrl(url, 'Scan URL');
  const launchTarget = browserDescriptor ?? 'chromium';
  const browser = await getBrowser(launchTarget);
  const context = await browser.newContext({ serviceWorkers: 'block', bypassCSP: true });
  const page = await context.newPage();

  try {
    onProgress?.('Opening page…', 10);
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    if (isCancelled?.()) {
      throw _cancelErr();
    }

    onProgress?.('Waiting for content readiness…', 25);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page
      .waitForFunction(
        () => document.readyState === 'complete' && document.querySelectorAll('*').length > 30,
        { timeout: 10_000 }
      )
      .catch(() => {});

    if (isCancelled?.()) {
      throw _cancelErr();
    }

    onProgress?.('Injecting tracking engine…', 45);
    await page.addScriptTag({ content: getTrackerBundleSource() });

    if (isCancelled?.()) {
      throw _cancelErr();
    }

    onProgress?.('Scanning elements…', 60);
    const scanOptions = {
      mode: mode ?? 'full_page',
      settings: settings ?? {},
      sessionId: `scan_${Date.now()}`,
      profiles: profiles ?? {},
    };
    const normalizedFilters = Array.isArray(filters) ? filters : filters ? [filters] : null;

    const result = await _withTimeout(
      page.evaluate(
        ({ f, opts }) => window.__elementTracker.scanPage(f, opts),
        { f: normalizedFilters, opts: scanOptions }
      ),
      SCAN_EVAL_TIMEOUT_MS,
      'page scan'
    );

    if (isCancelled?.()) {
      throw _cancelErr();
    }

    onProgress?.('Scan complete', 100);

    const scan = result?.scan ?? null;
    const elementCount = scan?.elements?.length ?? 0;
    log.info('[PM] runScan done', { url, elementCount });

    return {
      scan,
      profiles: result?.profiles ?? {},
      url,
      engine:
        typeof browserDescriptor === 'object' && browserDescriptor
          ? browserDescriptor.browserType ?? 'chromium'
          : browserDescriptor ?? 'chromium',
      platform: process.platform,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

module.exports = {
  runScan,
  getBrowser,
  shutdownPlaywright,
  getTrackerBundleSource,
};
