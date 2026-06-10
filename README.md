# Element Tracker (Desktop)

A cross-platform **Electron desktop app** that captures interactive web elements and generates resilient XPath and CSS selectors. Designed for SDET and QA-automation engineers building end-to-end test suites against complex single-page applications, including Salesforce Lightning, Workday, ServiceNow, and other enterprise platforms with heavy Shadow DOM and nested iframe usage.

It is a desktop port of the original Element Tracker Chrome extension: the same selector-generation engine now runs inside **Playwright-controlled browsers** instead of as a content script, so it works across Chromium, Firefox, and WebKit on Windows, macOS, and Linux without installing a browser extension.

## How it works

- **Record mode** (Interactions / Hybrid) — the app launches a real, **headed** Playwright browser that you drive by hand. Injected listeners capture your clicks, inputs, form submits, navigation, and scrolls and stream each event back to the app, where it is enriched and stored. Hybrid mode additionally lets you trigger a full-page scan on demand.
- **Scan mode** (Element Scan) — the app navigates a URL in a headless Playwright browser, injects the tracking engine, and enumerates every interactive element with full selector enrichment. Fully automated; no human interaction required.

The element-enrichment engine is bundled into a single `tracker-bundle.js`, injected via `page.addScriptTag` / `addInitScript`, and invoked through `window.__elementTracker`. Captured interactions stream out through a Playwright `exposeBinding` channel.

## Capabilities

- **Three tracking modes** — Interactions (live event capture), Element Scan (automated full-page enumeration), and Hybrid (both, deduplicated by XPath).
- **Resilient selector generation** — 22-tier XPath strategy tournament with early-exit and adaptive disambiguation, plus a multi-strategy CSS cascade. Every emitted selector is validated against the live DOM via `document.evaluate` / `querySelectorAll` before storage.
- **Up to three deduplicated fallbacks per element** — primary plus two diverse alternates, ranked by tier and a 30–100 robustness score.
- **Shadow DOM coverage** — open and closed roots, with framework heuristics for Salesforce Lightning, Aura, and LWC.
- **Cross-browser & cross-OS** — Playwright Chromium/Firefox/WebKit and any detected system Chromium-channel browser; packaged for Windows (NSIS), macOS (DMG), and Linux (AppImage/deb).
- **Domain attribute profiling** — learns stable, unique attributes per domain to improve XPath accuracy; profiles persist in IndexedDB across sessions.
- **Local-only** — zero network egress beyond the pages you choose to open. Captured data persists in IndexedDB and exports to JSON or CSV.

## Architecture

```
element-tracker-app/
├── electron-builder.yml         packaging (NSIS / DMG / AppImage+deb, asar, fuses)
├── webpack.main.config.js       Electron main process  → dist/index.js, preload.js
├── webpack.renderer.config.js   vanilla-JS renderer     → dist/renderer/
├── webpack.bundle.config.js     injected page engine    → dist/tracker-bundle.js (UMD)
└── src/
    ├── main/          Electron main: window, IPC, Playwright + record managers,
    │                  browser detection, app:// protocol, export save-dialog
    ├── renderer/      vanilla-JS UI: state container, workflows, components,
    │                  IndexedDB repository, design-token styles
    ├── core/          chrome-free DOM engine bundled into tracker-bundle.js
    │                  (capture/, enrichment/, helpers/, shared/, page-entry.js)
    └── security/      URL / path / descriptor guards
```

## Getting started

### Prerequisites

- Node.js (LTS) and npm
- Playwright browser binaries (`npm run install:browsers`)

### Develop

```bash
npm install
npm run install:browsers      # one-time: download Playwright Chromium/Firefox/WebKit
npm start                     # webpack watch (×3) + electron
```

`npm start` runs the three webpack builds in watch mode (main, renderer, bundle) alongside Electron.

### Build & package

```bash
npm run build                 # production bundles → dist/
npm run dist:win              # package for Windows  (also dist:mac / dist:linux)
```

## Usage

- **Record**: enter a start URL, pick Interactions or Hybrid, toggle capture types, choose a browser, and click **Start Recording**. Drive the launched browser; captured elements appear in the live counters and the sidebar. Click **Stop Recording** to finish. In Hybrid mode, **Scan Now** captures the current page on demand.
- **Scan**: enter a URL, optionally add comma-separated CSS-selector filters, and click **Scan Page**.
- **Export / manage**: each mode's card in the sidebar exports its captures as JSON or CSV (via a native save dialog) and clears its data. Storage usage is shown in the sidebar footer.

## License

MIT.
