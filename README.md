# Agentic Test Automation

A cross-platform **Electron desktop app** where you describe a browser flow in **plain
English** and an **AI agent drives a real browser to generate a runnable, self-healing
[Playwright](https://playwright.dev) test**. The agent never guesses selectors — it
grounds every action in a **ranked, DOM-validated locator inventory** produced by a custom
extraction engine. That grounding is what makes the generated tests resilient instead of
flaky, which is the #1 problem in UI test automation.

Built for SDET / QA-automation engineers working against complex single-page apps —
Salesforce Lightning, Workday, ServiceNow, and other enterprise platforms with heavy
Shadow DOM and nested iframes.

> **In one line:** the hard part of "English → working test" isn't the English — it's
> producing selectors that survive a real, changing DOM. This app solves that by capturing
> *validated, ranked* locators first, so the AI **chooses** from known-good selectors
> instead of inventing brittle ones.

📄 **Engineering deep dive:** [docs/PROJECT_DEEP_DIVE.md](docs/PROJECT_DEEP_DIVE.md) —
full architecture, the AI layer in depth, data-flow trace, and Q&A.

---

## How it works

The app has two halves that feed each other:

```
   CAPTURE  (build ground truth)                AUTOMATE  (use it)
 ┌──────────────────────────────────┐        ┌──────────────────────────┐
 │ Interactions │ Element Scan │ Hybrid │ ──► │   AI Automation          │ ──► .spec.ts
 │  (record)    │ (auto-scan)  │ (both) │     │   English → AI agent →   │     + live run
 └──────────────────────────────────┘        │   generate + self-heal   │     + report
            │                                 └──────────────────────────┘
            └──────────►  REPORTS (IndexedDB) ─────────────┘
                          ranked, validated locators
```

- **Capture** turns any page into a **Report** — a set of elements, each carrying a ranked,
  validated set of XPath/CSS locators. Three modes: **Element Scan** (automated headless
  full-page enumeration), **Interactions** (record a human driving a real headed browser),
  **Hybrid** (record + on-demand scans).
- **AI Automation** consumes a Report (optional) and your English steps; an AI agent drives
  a live browser to author/run/heal a Playwright test, scanning each page as it reaches it.

The element-enrichment engine is bundled into a single `tracker-bundle.js`, injected via
`page.addScriptTag` / `addInitScript`, and invoked through `window.__elementTracker`.

---

## The AI layer

- **Engine:** the app drives the **Claude Code CLI headlessly** (`claude -p`), authenticated
  by your existing Claude Code login — **no API key, no per-token billing**. This is also
  Playwright's officially-supported agent loop.
- **Grounding boundary:** the app ships an **MCP stdio server** exposing 7 tools
  (`navigate`, `scan_page`, `act`, `assert`, `list_reports`, `read_report`, `write_spec`).
  The agent references elements by an inventory **`ref` (a number), never a raw selector** —
  so it physically cannot hallucinate a locator.
- **Workflow:** planner → generator → healer. Plan English into intents → drive the live
  browser, scanning each page as reached and binding intents to validated locators →
  write a clean `.spec.ts` from what worked → on failure, tiered **self-heal** (next ranked
  locator for free, then re-scan + re-bind, else report — never guess).
- **Execution timing is Playwright's job:** the generated test relies on Playwright's
  auto-waiting / live locators; no rescan logic is baked into the exported spec.

> Requires [Claude Code](https://code.claude.com) installed and logged in (`claude login`)
> on the machine running an AI automation.

---

## Capabilities

- **AI test generation** — plain-English flow → runnable, self-healing Playwright `.spec.ts`,
  grounded in validated locators (no hallucinated selectors).
- **Four tabs** — Interactions, Element Scan, Hybrid (capture) + AI Automation.
- **Resilient selector engine** — 23-tier XPath strategy tournament with early-exit and
  adaptive disambiguation, plus a multi-strategy CSS cascade. Every selector is validated
  against the live DOM (`document.evaluate` / `querySelectorAll`) before storage.
- **Ranked fallbacks per element** — primary plus up to two diverse alternates, ranked by
  tier and a 30–100 robustness score (the basis for free tier-1 self-healing).
- **Shadow DOM coverage** — open and closed roots, with framework heuristics for Salesforce
  Lightning, Aura, and LWC.
- **Domain attribute profiling** — learns stable, unique attributes per domain to bias XPath
  generation toward durable attributes.
- **Cross-browser & cross-OS** — Playwright Chromium/Firefox/WebKit and detected system
  browsers; packaged for Windows (NSIS), macOS (DMG), Linux (AppImage/deb).
- **Persistent history** — Reports and AI Tests (with the English steps, generated spec, and
  run transcript) stored in IndexedDB; multi-format export (JSON / CSV / Playwright spec).

---

## Architecture

```
agentic-test-automation/
├── electron-builder.yml         packaging (NSIS / DMG / AppImage+deb, asar, fuses)
├── webpack.main.config.js       Electron main      → dist/index.js, preload.js
├── webpack.renderer.config.js   vanilla-JS UI      → dist/renderer/
├── webpack.bundle.config.js     injected engine    → dist/tracker-bundle.js (UMD)
├── webpack.mcp.config.js        AI tool server     → dist/mcp/server.js
└── src/
    ├── main/          Electron main: window, IPC, Playwright + record + AI managers,
    │                  browser detection, app:// protocol, export
    ├── mcp/           MCP stdio server (the AI agent's tool surface) + page session
    ├── renderer/      vanilla-JS UI: state container, workflows, components,
    │                  IndexedDB repository, design-token styles
    ├── core/          chrome-free DOM engine → tracker-bundle.js
    │                  (capture/, enrichment/, helpers/, shared/, automation/, page-entry.js)
    └── security/      URL / path / descriptor guards
```

Three browser contexts by design: the **renderer** (sandboxed UI, no Node), the **main
process** Playwright (headless scans + headed recording), and the **MCP server's** own
Playwright (the AI agent's live exploration). See the deep-dive doc for the full diagram
and process model.

---

## Getting started

### Prerequisites

- Node.js (LTS) and npm
- Playwright browser binaries (`npm run install:browsers`)
- For AI Automation: [Claude Code](https://code.claude.com) installed and logged in

### Develop

```bash
npm install
npm run install:browsers      # one-time: download Playwright Chromium/Firefox/WebKit
npm start                     # webpack watch (×4) + electron
```

### Build & package

```bash
npm run build                 # production bundles (main, renderer, bundle, mcp) → dist/
npm run dist:win              # package for Windows  (also dist:mac / dist:linux)
```

---

## Usage

- **AI Automation:** enter a Start URL, choose a browser, optionally pick a grounding
  Report, type the flow in plain English, and click **Generate Test**. Watch the live
  per-step run; the result is saved under the **AI Tests** tab (with the English steps,
  generated spec, and run log) and can be exported as a `.spec.ts`.
- **Element Scan:** enter a URL (+ optional CSS-selector filters) → **Scan Page** → a Report
  appears in the left pane.
- **Interactions / Hybrid:** enter a URL → **Start Recording** → drive the launched browser;
  captured elements stream into the live counters. Hybrid adds **Scan Now** for on-demand
  page scans. **Stop Recording** saves the Report.
- **Left pane:** switch between **Reports** and **AI Tests**; click any item to open its
  details (Reports show the element/locator table; AI Tests show steps + spec + transcript).
  Export or delete per item.

---

## License

MIT.
