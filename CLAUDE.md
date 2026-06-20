# CLAUDE.md

Guidance for Claude Code in this repository. **Skill routing and global working preferences live in `~/.claude/CLAUDE.md`** — this file adds project-specific context only.

## Project

Intent2Spec Agent — a cross-platform **Electron + Playwright** desktop app that captures interactive web elements, generates resilient XPath/CSS selectors, and turns plain-English flows into self-healing Playwright tests via a headless AI agent. Cross-platform (Windows/macOS/Linux), cross-browser (Chromium/Firefox/WebKit via Playwright).

- **Main**: `src/main/` — Electron main process: window lifecycle, IPC handlers, `playwright-manager` (automated headless scans), `record-manager` (headed live-capture sessions), `browser-detector`, `app://` protocol, export save-dialog.
- **Renderer**: `src/renderer/` — vanilla-JS UI (no framework): `state.js` (reduce/dispatch/subscribe), `application/` workflows, `components/`, `infrastructure/idb-repository.js` (IndexedDB), `styles/` (design tokens).
- **Core**: `src/core/` — the chrome-free DOM engine (capture/, enrichment/, helpers/, shared/). Bundled by `webpack.bundle.config.js` into `dist/tracker-bundle.js` (UMD global `__elementTracker`) and injected into Playwright pages. `page-entry.js` is its public surface.
- **Security**: `src/security/` — URL/path/descriptor guards.

## Build

Three webpack bundles: `build:main`, `build:renderer`, `build:bundle` (run all via `npm run build`). `npm start` runs all three in watch mode plus Electron. `npm run dist:{win,mac,linux}` packages via electron-builder.

## Project-specific rules

- **The injected engine (`src/core/`) must stay chrome-free and node-free.** It runs inside a browser page via `page.evaluate` / `addScriptTag`. No `chrome.*`, no `require('fs')`, no Electron. Node-only deps are aliased to `src/core/_page_stubs_/` in the bundle webpack config. After changing core, rebuild the bundle and confirm `grep chrome\\. dist/tracker-bundle.js` is empty.
- **Vanilla JS only in the renderer.** No React/JSX/Tailwind. The design system is the copied `src/renderer/styles/*` (tokens + base + shell + components + navigation + report-list) plus `tracker.css`; reuse `var(--color-*)` tokens, never hardcode colors.
- **Transport seam**: automated scans return their result as the `page.evaluate()` value; live Record sessions stream events out via the `__etEmit` exposeBinding. Don't reintroduce the extension's `chrome.runtime` messaging or the deleted `frame-channel` — Playwright owns frame orchestration.
- **`dist/`, `release/`, `node_modules/` are build/vendor output** — never lint or edit.
- Verify with: `npm run build`, `npm run lint`, and a headless scan against an `http://` fixture (Playwright requires http/https URLs).

## Planned (post-MVP)

Natural-language → executable Playwright scripts: feed an English instruction + the app's validated selector inventory to an LLM to generate runnable automation. Not yet started.
