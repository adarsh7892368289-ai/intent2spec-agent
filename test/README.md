# Test suite

Production-grade automated tests for Agentic Test Automation, run with
[Vitest](https://vitest.dev).

## Running

```bash
npm test              # full suite (node + jsdom + integration), one shot
npm run test:watch    # watch mode
npm run test:unit     # node-environment unit tests only
npm run test:jsdom    # DOM-dependent tests only
npm run test:integration   # real headless Playwright scan
npm run test:coverage # full suite + v8 coverage report (./coverage)
```

## Layout

| Dir | Environment | What it covers |
|-----|-------------|----------------|
| `test/unit/` | node | Pure logic: security guards, locator/action projection (the AI grounding boundary), state reducers, enrichment rankers, renderer utils, MCP page-session, ai-manager CLI detection. |
| `test/jsdom/` | jsdom (per-file `// @vitest-environment jsdom`) | DOM-dependent code: helpers (dom/css/xpath/visibility/shadow/enrichment), enrichment engines, capture predicates, IndexedDB repository (via `fake-indexeddb`), HTML sanitizer. |
| `test/integration/` | node + real Playwright | End-to-end engine verification: serves `fixtures/scan-fixture.html` over `http://`, launches headless Chromium, injects the built `dist/tracker-bundle.js`, runs the real `window.__elementTracker.scanPage`, and asserts a sane validated locator inventory. This is the gold-standard check from `CLAUDE.md`. |
| `test/fixtures/` | — | Static HTML fixtures. |
| `test/setup/` | — | Global setup (restores mocks after each test). |

## Conventions

- **Environment:** default is `node`. A DOM-dependent spec opts in with
  `// @vitest-environment jsdom` as its **first line**.
- **Aliases:** import app code exactly as the app does — `@security/...`,
  `@core/...`, or a relative path into `src/` (there is no `@renderer` alias).
- **Isolation:** modules with singleton state (the renderer state container, the
  notification queue, the IndexedDB repo, the bundle-source cache) are re-imported
  fresh per test via `vi.resetModules()` + dynamic import.
- **jsdom has no layout engine:** `getBoundingClientRect` returns zeros and
  `getComputedStyle` is limited. Visibility/position/layout logic is tested by
  stubbing those methods; the real layout-sensitive paths are covered by the
  integration test in a real browser instead.

## Prerequisites for the integration test

`npm run build:bundle` (produces `dist/tracker-bundle.js`) and Playwright
Chromium (`npm run install:browsers`). The integration spec **skips itself with a
reason** if either is absent, so the rest of the suite still runs on a fresh
checkout.
