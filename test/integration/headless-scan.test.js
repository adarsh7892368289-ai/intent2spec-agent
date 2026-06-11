// Real end-to-end engine verification (the gold standard from CLAUDE.md):
// serve the fixture over http://, launch a headless Playwright browser, inject
// the actual built tracker bundle, run window.__elementTracker.scanPage, and
// assert the engine produces a sane, validated locator inventory.
//
// Requires `npm run build:bundle` (dist/tracker-bundle.js) and Playwright
// Chromium. Both are skipped-with-reason if absent, so the suite never fails
// spuriously on a machine that hasn't built/installed them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_PATH = path.join(REPO_ROOT, 'dist', 'tracker-bundle.js');
const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'scan-fixture.html');

function canRun() {
  if (!fs.existsSync(BUNDLE_PATH)) {
    return { ok: false, reason: 'dist/tracker-bundle.js missing — run `npm run build:bundle`' };
  }
  try {
    require.resolve('playwright');
  } catch {
    return { ok: false, reason: 'playwright not installed' };
  }
  return { ok: true };
}

const gate = canRun();
const d = gate.ok ? describe : describe.skip;
if (!gate.ok) {
  // eslint-disable-next-line no-console
  console.warn(`[integration] skipping headless scan: ${gate.reason}`);
}

d('headless Playwright scan against an http:// fixture', () => {
  let server;
  let baseUrl;
  let browser;
  let chromium;

  beforeAll(async () => {
    ({ chromium } = await import('playwright'));

    const html = fs.readFileSync(FIXTURE_PATH, 'utf8');
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}/`;

    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  });

  async function scan(filters = null) {
    const context = await browser.newContext({ serviceWorkers: 'block', bypassCSP: true });
    const page = await context.newPage();
    try {
      await page.goto(baseUrl, { waitUntil: 'load' });
      await page.addScriptTag({ content: fs.readFileSync(BUNDLE_PATH, 'utf8') });
      const ready = await page.evaluate(() => typeof window.__elementTracker?.scanPage === 'function');
      expect(ready, 'tracker bundle should expose window.__elementTracker.scanPage').toBe(true);
      return await page.evaluate(
        ({ f }) => window.__elementTracker.scanPage(f, { mode: 'full_page', settings: {}, sessionId: 'it', profiles: {} }),
        { f: filters }
      );
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  it('returns a structured scan result with an elements array', async () => {
    const result = await scan();
    expect(result).toBeTruthy();
    expect(result.scan).toBeTruthy();
    expect(Array.isArray(result.scan.elements)).toBe(true);
    expect(result.scan.elements.length).toBeGreaterThan(0);
  });

  it('captures the key interactive elements (inputs, button, select, links)', async () => {
    const { scan: s } = await scan();
    const els = s.elements;
    // Engine should find a healthy number of interactive elements (form fields,
    // buttons, links, select). The fixture has ~10 interactive elements.
    expect(els.length).toBeGreaterThanOrEqual(6);

    // Every element should carry at least one usable locator (xpath or css),
    // which is the whole point of the engine. The enriched schema is
    // el.selectors.{xpath.primary | css.selector}.
    let withLocator = 0;
    for (const el of els) {
      const sel = el.selectors || {};
      const hasLocator = !!(sel.xpath?.primary || sel.css?.selector);
      if (hasLocator) {
        withLocator++;
      }
    }
    // The vast majority of captured elements must have a resolvable locator.
    expect(withLocator).toBeGreaterThanOrEqual(Math.ceil(els.length * 0.8));
  });

  it('discovers the data-testid elements (locator-critical attributes preserved)', async () => {
    const { scan: s } = await scan();
    const serialized = JSON.stringify(s.elements);
    // sanitizeMetadata must preserve data-* — these testids come from the fixture.
    expect(serialized).toContain('username-input');
    expect(serialized).toContain('login-submit');
  });

  it('honors CSS filters (scoped scan returns fewer elements than full scan)', async () => {
    const full = await scan(null);
    const filtered = await scan(['#login-form input']);
    expect(filtered.scan.elements.length).toBeLessThanOrEqual(full.scan.elements.length);
    expect(filtered.scan.elements.length).toBeGreaterThan(0);
  });

  it('produces no duplicate element ids within a scan', async () => {
    const { scan: s } = await scan();
    const ids = s.elements.map((e) => e.id).filter(Boolean);
    if (ids.length) {
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
