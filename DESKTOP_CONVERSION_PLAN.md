# Element Tracker → Electron Desktop App — Conversion Plan

Convert the **Element Tracker** Chrome MV3 extension into a cross-platform Electron
desktop app, mirroring the architecture and design system of **ui-comparison-desktop**
(the reference app at `c:/Projects/ui-comparison-desktop`).

**Scope:** same feature set as today — no new features. Three tracking modes
(Interactions, Element Scan, Hybrid), all capture types, the full XPath/CSS selector
engine, JSON/CSV export, stats, and data management. Cross-browser (Chromium / Firefox /
WebKit via Playwright) and cross-OS (Windows / macOS / Linux via electron-builder).

## Decisions locked (from user)

| Decision | Choice |
|---|---|
| Live Interactions/Hybrid capture | **Headed Playwright window** the user drives; events streamed back via `page.exposeBinding` |
| Browser login/profile | **Fresh ephemeral session** each run (no persistent profile) |
| Storage | **IndexedDB in renderer**, mirroring `idb-repository.js` |
| UI | **Adopt ui-comparison's design system + app-shell**, populated with Element Tracker controls |

---

## 1. Target architecture

Three execution contexts, exactly like the reference:

```
┌─────────────────────────────────────────────────────────────────┐
│ ELECTRON MAIN  (src/main/)            Node — orchestrator         │
│  • index.js        app boot, BrowserWindow, app:// protocol, CSP  │
│  • preload.js      contextBridge → window.elementTrackerAPI       │
│  • ipc-channels.js  + ipc-handlers.js   (ipcMain.handle catalog)  │
│  • playwright-manager.js   launch browsers, inject bundle,        │
│       run scans (page.evaluate), drive headed record sessions     │
│       (addInitScript + exposeBinding event stream)                │
│  • browser-detector.js     cross-OS browser discovery (cloned)    │
│  • resource-paths.js, protocol-handler.js, security/* (cloned)    │
└─────────────────────────────────────────────────────────────────┘
            ▲  ipcRenderer.invoke / push events          │ addScriptTag / evaluate / exposeBinding
            │                                            ▼
┌──────────────────────────────┐   ┌──────────────────────────────────┐
│ RENDERER  (src/renderer/)    │   │ INJECTED BUNDLE (tracker-bundle)  │
│  vanilla JS + CSS tokens     │   │  pure DOM — runs in Playwright    │
│  • app.js, state.js, ui.js   │   │  page context                     │
│  • components/* (app-shell,  │   │  • window.__elementTracker = {    │
│      toast, modal, status…)  │   │      scanPage(filters, cfg),      │
│  • application/* workflows   │   │      startCapture(modes, cfg),    │
│  • styles/* (tokens, shell…) │   │      stopCapture() }              │
│  • idb-repository.js storage │   │  • bundles enrichment + capture   │
└──────────────────────────────┘   │    + selector engine (chrome-free)│
                                    └──────────────────────────────────┘
```

### Source layout (new)

```
src/
  main/                      NEW — Electron main process
    index.js
    preload.js
    ipc-channels.js
    ipc-handlers.js
    playwright-manager.js
    browser-detector.js      (cloned & trimmed from reference)
    resource-paths.js        (cloned)
    protocol-handler.js      (cloned, blob logic removed — not needed)
  core/                      MOVED from src/content + src/shared (chrome-free)
    capture/                 click/input/form/navigation/scroll/page-scanner
    enrichment/              xpath-engine, css-engine, label-extractor, …
    helpers/                 dom-utils, shadow-dom-traverser, text-utils, …  (frame-channel.js DELETED)
    selectors/ …             (kept inside enrichment as today)
    shared/                  config, di-container, heuristics-engine, schemas,
                             utils, safe-execute, error-tracking, attribute-profiler
    page-entry.js            NEW — bundle entry, exposes window.__elementTracker
    _page_stubs_/            NEW — chrome-shim, electron-log stub
  renderer/                  NEW — vanilla-JS UI (design system from reference)
    index.html
    app.js  state.js  ui.js  theme-bootstrap.js
    application/  (record-workflow, scan-workflow, export-workflow, report-manager, notification-queue)
    components/   (app-shell, browser-selector, toast, modal, status-bar, system-banner, result/report panels)
    styles/       (tokens, base, shell, components, navigation, report-list, result-panel)  ← copied + retoned
    infrastructure/  idb-repository.js, logger.js, error-tracker.js
    utils/  icons, sanitize, time
  security/                  guards.js, path-guards.js (cloned from reference)
```

The current `src/background/`, `src/content/`, `src/popup/`, `manifest.json` are
removed once their logic is ported (background → main, content → core+bundle, popup →
renderer). We keep them until each piece is verified, then delete in the final cleanup step.

---

## 2. The porting template (how content scripts become an injected bundle)

This is exactly how the reference works (`webpack.extractor.config.js` +
`playwright-manager.js`), applied to our `content/` pipeline:

1. **New webpack bundle config** `webpack.bundle.config.js` (cloned from
   `webpack.extractor.config.js`): entry `src/core/page-entry.js`, output
   `dist/tracker-bundle.js`, UMD `library: { name: '__elementTracker', type: 'umd' }`,
   `target: web`, `splitChunks:false`.
2. **`page-entry.js`** imports the scan + capture + enrichment modules and exposes:
   - `scanPage(filters, cfg)` → runs `PageScanner.scanPage`, returns the scan-data object (the value `page.evaluate` returns).
   - `startCapture(mode, settings)` → instantiates the relevant capture modules (Click/Input/Form/Navigation/Scroll), wiring each captured interaction to `window.__etEmit(payload)` (the exposeBinding) instead of `chrome.runtime.sendMessage`.
   - `stopCapture()` → destroys capture modules.
3. **Decouple chrome.* (only 2 files touch it).** Introduce a tiny transport seam so
   the same modules run in both the extension-era code and the page bundle:
   - `injector.js` → **deleted** (extension bootstrap; Playwright + main replace it).
   - `event-manager.js` → split: the chrome-free orchestration (mode → which capture
     modules) moves into `page-entry.js`; the 8 `chrome.*` calls are replaced by:
     `GET_SETTINGS`/`GET_SESSION` → params passed into `scanPage`/`startCapture`;
     `chrome.runtime.sendMessage(INTERACTION/PAGE_SCAN)` → `window.__etEmit(...)`;
     `chrome.runtime.onMessage` → not needed (main calls functions directly);
     `chrome.runtime.id` context check → removed.
   - `frame-channel.js` → **deleted**; Playwright's `page.frames()` + per-frame
     `addInitScript`/`evaluate` replace BroadcastChannel/postMessage cross-frame logic.
4. **`_page_stubs_/`** aliases in the bundle webpack config:
   `electron-log` → console shim; a `chrome` shim is unnecessary once the 2 files are
   refactored (preferred — no global `chrome` left in `core/`).
5. **Injection (main process), per mode:**
   - **Element Scan (automated):** `browser.newContext()` → `page.goto(url)` → wait for
     readiness → `page.addScriptTag({ content: trackerBundleSource })` →
     `report = await page.evaluate(() => window.__elementTracker.scanPage(filters, cfg))`
     → return report to renderer. (Direct analog of reference `runExtraction`.)
   - **Interactions / Hybrid (headed, human-driven):** launch `headless:false`,
     `context.exposeBinding('__etEmit', (src, payload) => forwardToRenderer(payload))`,
     `context.addInitScript({ content: bundle + '\nwindow.__elementTracker.startCapture(mode,settings)' })`
     so listeners reattach on every navigation/frame, then `page.goto(url)`. The user
     drives the window; each captured interaction streams to main → renderer → IndexedDB.
     `page.on('framenavigated')` and `page.on('close')` manage lifecycle. Hybrid also
     runs a `scanPage` pass on demand (the "Scan" button), deduped by XPath as today.

---

## 3. Architecture mapping (chrome-extension piece → desktop)

| Extension piece | Desktop equivalent |
|---|---|
| `background/service-worker.js` | `main/index.js` (boot + lifecycle) |
| `background/message-router.js` (MESSAGE_TYPES hub) | `main/ipc-handlers.js` (`ipcMain.handle` per channel) + `ipc-channels.js` |
| `background/storage-controller.js`, `memory-manager.js`, `session-controller.js` | `renderer/infrastructure/idb-repository.js` (versioned stores, quota, transactions) + small session helper in main |
| `background/badge-controller.js` | `renderer/components/status-bar.js` (tracking indicator) |
| `content/` enrichment + scan + capture | `core/` modules bundled into `tracker-bundle.js` |
| `content/injector.js` | deleted (Playwright injects) |
| `content/helpers/frame-channel.js` | deleted (Playwright `page.frames()`) |
| `popup/popup.{html,css,js}` | `renderer/` window + app-shell + components |
| `popup/export-manager.js` (Blob download) | export logic kept; download → `dialog.showSaveDialog` + `fs.writeFile` IPC |
| `chrome.storage.local` | IndexedDB (`idb-repository`) |
| `chrome.tabs` / `chrome.webNavigation` | Playwright `page.goto`, `page.on('framenavigated')` |
| `chrome.scripting.executeScript` | `page.addScriptTag` / `context.addInitScript` |
| `chrome.runtime.sendMessage` (out) | `window.__etEmit` (exposeBinding) → IPC push to renderer |
| Hibernation resilience (`chrome.storage.session`) | deleted (no SW hibernation in Electron) |

### IPC channel catalog (initial)

`GET_AVAILABLE_BROWSERS`, `GET_VERSION`, `GET_HOST_MEMORY` (meta);
`SCAN_PAGE` (automated Element-Scan, returns report);
`START_RECORD_SESSION` / `STOP_RECORD_SESSION` (headed capture lifecycle);
push: `RECORD_EVENT` (streamed interaction), `RECORD_SCAN` (hybrid scan result),
`SCAN_PROGRESS`, `RECORD_SESSION_CLOSED`, `APP_NOTIFICATION`;
`EXPORT_FILE` (JSON/CSV save dialog); `CANCEL_OPERATION`; `SET_WINDOW_TITLE`.

---

## 4. Renderer UI (adopt reference design system)

- **Copy `styles/` wholesale** (`tokens.css`, `base.css`, `shell.css`, `components.css`,
  `navigation.css`, `report-list.css`, `result-panel.css`) and re-tone only as needed.
  Keep `theme-bootstrap.js` + light/dark toggle.
- **Reuse the app-shell + components** (`app-shell.js`, `toast.js`, `modal.js`,
  `status-bar.js`, `system-banner.js`, `browser-selector.js`, tooltip) — these are
  feature-agnostic.
- **Populate the shell with Element Tracker controls** (replacing extract/compare/bulk/sauce):
  - **Left panel:** captured-data list grouped by mode/session (analog of report-list).
  - **Main pane — section nav tabs:** `Record` (Interactions/Hybrid live capture) and
    `Scan` (automated Element-Scan).
    - **Record tab:** URL input, browser selector, mode (Interactions/Hybrid), capture-type
      toggles (clicks/inputs/forms/navigation/scroll), Start/Stop, live stats grid
      (clicks/inputs/forms/navigation counts; hybrid adds scans/elements).
    - **Scan tab:** URL input, browser selector, optional CSS-selector filter, Scan button,
      progress bar, elements-found count.
  - **Export:** JSON / CSV split-button (per the reference's export-split control), wired
    to the ported `export-manager` logic via the `EXPORT_FILE` IPC + save dialog.
  - **Data management:** Clear current mode / Clear all (modal confirm).
  - **Status bar:** tracking state, counts, theme toggle.
- **State container:** clone `state.js` reducer pattern; replace compare/bulk/sauce slices
  with `mode`, `recordSession`, `scanProgress`, `captures`, `stats`, `selectedBrowser`,
  `availableBrowsers`.

---

## 5. Build & packaging (match reference)

- **package.json**: switch to Electron app. `main: "dist/main/index.js"`. Add deps
  `electron`, `electron-builder`, `playwright`, `electron-log`; keep babel/webpack.
  Scripts: `build:bundle`, `build:main`, `build:renderer`, `build`, `start`
  (concurrently watch + `electron .`), `dist:win|mac|linux`, `install:browsers`.
- **Three webpack configs** (cloned/trimmed): `webpack.main.config.js`
  (`target: electron-main`, externals playwright/electron-log), `webpack.renderer.config.js`
  (`target: web` + CopyStaticAssets for html/styles), `webpack.bundle.config.js`
  (UMD `__elementTracker`).
- **electron-builder.yml** cloned: app id/product name `Element Tracker`, asar with
  `asarUnpack` for `tracker-bundle.js` + playwright + `*.node`, bundle Playwright
  browsers via `extraResources` + `PLAYWRIGHT_BROWSERS_PATH`, NSIS/DMG/AppImage targets,
  fuses afterPack.
- **Security posture (inherited):** `contextIsolation:true`, `sandbox:true`, no
  nodeIntegration, custom `app://` protocol + CSP, blocked navigation/webview,
  `security/guards.js` + `path-guards.js`. (The headed *target* browser is separate and
  intentionally unsandboxed — it's the page under test, launched by Playwright.)

---

## 6. Implementation phases (incremental, verifiable)

1. **Scaffold Electron shell.** New `package.json`/webpack/builder configs; minimal
   `main/index.js` + `preload.js` + `renderer/index.html` (copied styles) that boots an
   empty window. Verify: `npm start` opens the app-shell window.
2. **Move chrome-free core.** Relocate `content/` (minus injector/frame-channel) and
   `shared/` into `src/core/`; fix import paths; add `_page_stubs_`. Verify: `npm run
   build:bundle` produces `tracker-bundle.js` with no `chrome`/node references.
3. **Build `page-entry.js` + transport seam.** Refactor the `event-manager`/`injector`
   chrome calls into `scanPage`/`startCapture`/`stopCapture` + `__etEmit`. Verify with a
   unit/dom test that `scanPage` returns enriched elements.
4. **Main: Playwright + automated Scan.** Clone `playwright-manager` (scan path),
   `browser-detector`, IPC `SCAN_PAGE`. Verify: scanning a real URL returns enriched
   elements end-to-end into the renderer.
5. **Main: headed Record sessions.** `START/STOP_RECORD_SESSION`, `addInitScript` +
   `exposeBinding`, frame re-injection, event streaming. Verify: clicking/typing in the
   driven browser streams captures into the app for Interactions + Hybrid.
6. **Renderer UI + state + IndexedDB.** Populate app-shell with Record/Scan tabs, stats,
   data list; clone `idb-repository`; persist captures/stats; clear-by-mode/all.
7. **Export.** Port `export-manager` JSON/CSV logic; wire `EXPORT_FILE` save-dialog IPC.
8. **Polish + cleanup.** Status bar indicator, notifications, theme; delete
   `background/`, `content/`, `popup/`, `manifest.json`; update README/docs; lint.

---

## 7. Risks & notes

- **Selector engine fidelity:** the XPath/CSS engines are pure DOM and run unchanged in
  `page.evaluate` — highest-value, lowest-risk. Validation via `document.evaluate` /
  `querySelectorAll` still works inside the page.
- **Cross-frame:** replacing FrameChannel with Playwright frames changes how iframe
  captures correlate; for Scan we iterate `page.frames()`, for Record we `addInitScript`
  to all frames. This removes ~1500 lines (`frame-channel.js`) but needs careful
  per-frame session tagging.
- **Firefox/WebKit launchability:** per `browser-detector`, system Firefox/WebKit are
  read-only; Playwright-managed engines are the launchable cross-browser path (bundled).
- **Headed capture UX:** two windows (app + driven browser). Acceptable per decision.
- **No persistent login:** ephemeral context per decision; recording auth-gated apps
  requires logging in each session.
```
