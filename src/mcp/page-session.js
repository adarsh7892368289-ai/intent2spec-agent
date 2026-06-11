'use strict';

// A single, long-lived browser page the MCP tools operate on across calls.
// The agent navigates → scans → acts → asserts on the SAME page (the
// explore-and-author model), so unlike playwright-manager.runScan (one context
// per call) we keep one context+page alive for the session's lifetime.
//
// Reuses playwright-manager for browser launch + bundle source, and the chrome-
// free tracker bundle (window.__elementTracker.scanPage) for locator capture.

const fs = require('fs');
const path = require('path');
const { chromium, firefox, webkit } = require('playwright');

let _bundleSource = null;

// Upper bound for one in-page scanPage() evaluate. page.evaluate has no native
// timeout, so a pathological DOM (huge node count, runaway enrichment) could
// otherwise block a tool call indefinitely.
const SCAN_EVAL_TIMEOUT_MS = 45_000;

function getTrackerBundleSource() {
  if (_bundleSource !== null) {
    return _bundleSource;
  }
  const candidates = [
    path.join(__dirname, '..', 'tracker-bundle.js'), // dist/mcp/../tracker-bundle.js
    path.join(process.cwd(), 'dist', 'tracker-bundle.js'),
  ];
  for (const c of candidates) {
    try {
      _bundleSource = fs.readFileSync(c, 'utf8');
      return _bundleSource;
    } catch {
      void 0;
    }
  }
  throw new Error('tracker-bundle.js not found — run: npm run build:bundle');
}

class PageSession {
  constructor({ browserType = 'chromium', headless = true } = {}) {
    this.browserType = browserType;
    this.headless = headless;
    this.browser = null;
    this.context = null;
    this.page = null;
    // url/state -> { elements, scannedAt }
    this.inventoryCache = new Map();
    this.lastScanKey = null;
  }

  // Reject `promise` if it doesn't settle within `ms`. The underlying evaluate
  // keeps running in the page, but the caller is freed and can recover.
  _withTimeout(promise, ms, label) {
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

  async _ensurePage() {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    const launcher = { chromium, firefox, webkit }[this.browserType] || chromium;
    this.browser = await launcher.launch({ headless: this.headless });
    this.context = await this.browser.newContext({ serviceWorkers: 'block', bypassCSP: true });
    this.page = await this.context.newPage();
    // Mark the page dirty whenever it navigates so the next scan re-captures.
    this.page.on('framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) {
        this.lastScanKey = null;
      }
    });
    return this.page;
  }

  async navigate(url) {
    const page = await this._ensurePage();
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    this.lastScanKey = null;
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  // Inject the tracker bundle (idempotent) and run a full/filtered scan of the
  // CURRENT page. Returns the enriched element array. Caches by URL.
  async scan({ filters = null, force = false } = {}) {
    const page = await this._ensurePage();
    const key = page.url();

    if (!force && this.lastScanKey === key && this.inventoryCache.has(key)) {
      return this.inventoryCache.get(key).elements;
    }

    // Readiness: settled DOM before capture.
    await page
      .waitForFunction(
        () => document.readyState === 'complete' && document.querySelectorAll('*').length > 20,
        { timeout: 10_000 }
      )
      .catch(() => {});

    // Inject the engine and CONFIRM it actually defined the global. addScriptTag's
    // failure is swallowed (a benign re-inject on the same document is fine), but a
    // genuine injection failure would otherwise surface later as a cryptic
    // "Cannot read properties of undefined (reading 'scanPage')". Verify + retry once.
    await page.addScriptTag({ content: getTrackerBundleSource() }).catch(() => {});
    let ready = await page
      .evaluate(() => typeof window.__elementTracker?.scanPage === 'function')
      .catch(() => false);
    if (!ready) {
      await page.addScriptTag({ content: getTrackerBundleSource() }).catch(() => {});
      ready = await page
        .evaluate(() => typeof window.__elementTracker?.scanPage === 'function')
        .catch(() => false);
    }
    if (!ready) {
      throw new Error('tracker engine failed to load on the page (injection blocked or page navigated mid-scan)');
    }

    const normalizedFilters = Array.isArray(filters) ? filters : filters ? [filters] : null;
    // page.evaluate has no built-in timeout; bound the in-page scan so a runaway
    // enrichment pass on a pathological DOM can't hang the whole agent run.
    const result = await this._withTimeout(
      page.evaluate(
        ({ f, opts }) => window.__elementTracker.scanPage(f, opts),
        { f: normalizedFilters, opts: { mode: 'full_page', settings: {}, sessionId: 'mcp', profiles: {} } }
      ),
      SCAN_EVAL_TIMEOUT_MS,
      'page scan'
    );
    const elements = result?.scan?.elements ?? [];
    this.inventoryCache.set(key, { elements, scannedAt: Date.now() });
    this.lastScanKey = key;
    return elements;
  }

  page_() {
    return this._ensurePage();
  }

  async close() {
    try {
      await this.context?.close();
    } catch {
      void 0;
    }
    try {
      await this.browser?.close();
    } catch {
      void 0;
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

module.exports = { PageSession, getTrackerBundleSource };
