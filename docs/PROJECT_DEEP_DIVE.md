# Agentic Test Automation — Engineering Deep Dive

> Interview-grade reference. Explains what the system does, how every layer works,
> the architecture and the *why* behind each decision, and the AI layer in depth.
> Grounded in the actual code (file paths cited throughout).

---

## 0. The 30-second pitch

> A cross-platform desktop app where you describe a browser flow in **plain English**
> and an **AI agent** drives a real browser to **generate a runnable, self-healing
> Playwright test**. The agent never guesses selectors — it grounds every action in a
> **ranked, DOM-validated locator inventory** produced by a custom extraction engine.
> That grounding is what makes the generated tests resilient instead of flaky, which is
> the #1 problem in UI test automation.

**One-sentence "what's hard about this":** the hard part of NL→test is *not* the English
(LLMs do that trivially) — it's producing selectors that survive a real, changing DOM.
The whole architecture exists to solve that.

---

## 1. The problem (why this matters)

UI test automation has three expensive, universal pains:

1. **Authoring cost** — writing a Playwright test means hunting selectors in DevTools and
   hand-wiring waits. Slow, and it needs coding skill.
2. **Flaky selectors** — CSS/XPath tied to DOM structure break on the next deploy.
   Playwright's own docs say CSS/XPath "can break when the DOM structure changes."
3. **Maintenance** — when a test breaks, someone re-opens DevTools, finds the new
   selector, patches the spec. This is the bulk of automation upkeep.

This project attacks all three: English-in (authoring), grounded resilient locators
(flakiness), and self-healing + repair (maintenance).

---

## 2. System overview & the two halves

The app has two halves that feed each other:

```
   CAPTURE half  (build ground truth)            AUTOMATE half  (use it)
 ┌──────────────────────────────────┐         ┌───────────────────────────┐
 │ Interactions │ Element Scan │ Hybrid │ ───► │   AI Automation tab       │ ──► .spec.ts
 │  (record)    │  (auto-scan) │ (both) │      │   English → AI agent →    │     + live run
 └──────────────────────────────────┘         │   generate + self-heal    │     + report
            │                                  └───────────────────────────┘
            └────────►  REPORTS (IndexedDB) ──────────────┘
                        ranked, validated locators
```

- **Capture half** (built, pre-existing engine): turns any page into **Reports** — each a
  set of elements, each element carrying a *ranked, validated* set of locators.
- **AI half** (the new work): an agent consumes a Report as grounding + drives a live
  browser to author/run/heal a Playwright test.

The four tabs: **Interactions** (record human clicks/inputs/forms/nav/scroll in a real
browser), **Element Scan** (automated headless full-page enumeration), **Hybrid**
(record + on-demand scans), **AI Automation** (the agent).

---

## 3. Architecture (the layers)

```
┌─ Electron RENDERER (vanilla JS, no framework) ──────────────────────────────┐
│  4 tabs · left-pane Reports|AI Tests lists · details panels · live streams   │
│  state.js (reduce/dispatch/subscribe) · IndexedDB repository                 │
│  application/*-workflow.js  ·  components/*  ·  styles/* (design tokens)      │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ IPC over contextBridge (preload.js) — no nodeIntegration
┌───────────────▼─ Electron MAIN process (Node) ──────────────────────────────┐
│  index.js          window lifecycle, app:// protocol, security hardening     │
│  ipc-handlers.js   ipcMain.handle(...) — the command surface                 │
│  playwright-manager.js   headless scan launch + bundle injection             │
│  record-manager.js       headed live-capture session (exposeBinding stream)  │
│  ai-manager.js           spawns Claude Code headlessly, parses stream-json   │
│  browser-detector.js     cross-OS browser detection (registry/bundles/PATH)  │
└──────┬──────────────────────────────┬──────────────────┬─────────────────────┘
       │ injects (addScriptTag)        │ spawns (claude -p) │ spawns (stdio)
┌──────▼─ tracker-bundle.js ──┐  ┌──────▼─ Claude Code ──┐  ┌▼─ MCP server ─────┐
│ chrome-free DOM engine      │  │ headless agent loop   │  │ navigate/scan/act/ │
│ (window.__elementTracker)   │  │ planner→gen→healer    │◄─┤ assert/write_spec  │
│ 23-tier XPath + CSS cascade │  │ uses YOUR login       │  │ (own Playwright +  │
│ runs INSIDE the page        │  │ (no API key)          │  │ locator projection)│
└─────────────────────────────┘  └───────────────────────┘  └────────────────────┘
```

**Process model — why three "browsers" exist:**
- The **renderer** is the UI (Chromium, sandboxed, no Node).
- The **main process** drives Playwright for **automated scans** and **headed recording**.
- The **MCP server** is a *separate Node process* Claude Code spawns; it runs its **own**
  Playwright instance for the AI agent's live exploration.

This separation is deliberate: the AI agent (driven by Claude Code, a separate process)
can't reach the main process's objects, so the MCP server is self-contained.

### LOC by area (scale signal)
- `src/core/` (the DOM engine): **~13,400 lines, 36 files** — the bulk; XPath/CSS/Shadow.
- `src/renderer/`: ~3,500 lines — UI, state, workflows, IndexedDB.
- `src/main/`: ~2,050 lines — Electron + Playwright + AI orchestration.
- `src/mcp/`: ~480 lines — the agent's tool server.
- `src/security/`: ~110 lines — URL/path/descriptor guards.

---

## 4. The extraction engine (the "ground truth" — why it's the moat)

Lives in `src/core/`, bundled into `dist/tracker-bundle.js` (UMD global
`window.__elementTracker`) and **injected into the page**. Pure DOM — no `chrome.*`, no
Node (verified: the bundle is grep-clean of both).

### 4.1 What "enrichment" produces per element
`src/core/enrichment/enricher.js` → `enrichElement(el, ctx)` runs a pipeline and returns
a rich record: `selectors.{xpath,css}` (with tier/strategy/robustness/fallbacks), `name`,
`label`, `tagName`, `metadata` (id/role/type/aria-*/data-*), `hierarchy` (parent chain),
`context` (nearby labelled elements), `location`, shadow-DOM context, and `eventData` for
interactions. For performance it runs XPath + CSS + label + parent + metadata generation
**in parallel** with **adaptive timeouts** (`safeExecuteWithRetry`, timeouts tuned by
`heuristics-engine.js` from DOM node count + shadow depth), then `nearby`/`description`
sequentially. Batches yield to the event loop via `requestIdleCallback`.

### 4.2 XPath: a 23-tier strategy tournament
`src/core/shared/config.js` defines **23 ranked tiers** (`TIER_0`…`TIER_22`), tried in
priority order with early-exit:

```
0 exactVisibleText   1 testAttributes   2 stableId        3 visibleTextNormalized
4 precedingContext   5 descendantContext 6 attrTextCombo  7 followingContext
8 frameworkAttrs     9 multiAttrFingerprint  10 ariaRoleLabel  11 labelAssociation
12 partialTextMatch  13 hrefPattern    14 parentChildAxes 15 siblingAxes
16 semanticAncestor  17 classAttrCombo 18 ancestorChain   19 tableRowContext
20 svgVisualFingerprint  21 spatialTextContext  22 guaranteedPath (always works)
```
Each candidate is **validated against the live DOM** (`document.evaluate`, uniqueness
check) before it's accepted. Up to **2 diverse fallbacks** per element (`MAX_FALLBACKS`),
ranked by tier + a 30–100 **robustness score**. Tier 22 is a guaranteed absolute path so
there's always *something*.

### 4.3 CSS cascade + Shadow DOM + attribute profiling
- CSS engine: a multi-strategy cascade (id-selector → data-attributes → combined-attrs →
  class-attr → parent-child → pseudo-classes), each validated via `querySelectorAll`.
- **Shadow DOM**: open + closed roots pierced (`shadow-dom-traverser.js`), composite
  selectors for Salesforce Lightning/Aura/LWC.
- **Attribute profiler** (`attribute-profiler.js`): per-domain learning of which
  attributes are stable/unique (uniqueness rate, coverage, framework-invariance scoring)
  to bias XPath generation toward durable attributes. It was de-chromed for the desktop
  port: an in-memory profile map seeded/exported across runs instead of `chrome.storage`.

**Interview point:** this engine is the moat. Anyone can prompt an LLM; few feed it a
*validated, ranked* locator set. That's why the output is resilient.

---

## 5. Capture modes (how Reports get built)

All three produce a **Report** (metadata + element array). They differ in *how*:

| Mode | Mechanism | Main-process driver |
|---|---|---|
| **Element Scan** | Headless Playwright → `page.goto` → inject bundle → `scanPage()` enumerates every interactive element (scroll-to-reveal, readiness gate) | `playwright-manager.runScan` |
| **Interactions** | **Headed** Playwright the user drives; capture modules stream each event out | `record-manager` |
| **Hybrid** | Interactions + on-demand `triggerScan` mid-session | `record-manager` |

### 5.1 The injection mechanism (key technique)
`playwright-manager.js`: `await page.addScriptTag({ content: bundleSource })` injects the
UMD engine, then `await page.evaluate(() => window.__elementTracker.scanPage(...))` runs
it **inside the page context** and returns plain JSON. This is the "Chrome extension
content-script → injected bundle" port pattern.

### 5.2 Live event streaming (the headed-record trick)
`record-manager.js` launches a **headed** browser, then:
- `context.addInitScript({ content: bundle + startCapture })` — re-arms capture on **every
  navigation** (survives page changes), and
- `context.exposeBinding('__etEmit', (src, payload) => …)` — the in-page capture modules
  call `window.__etEmit(event)` and Playwright delivers it to the Node main process, which
  streams it to the renderer over IPC. This replaces the Chrome extension's
  `chrome.runtime.sendMessage`.

---

## 6. The AI layer (deep dive — the interview centerpiece)

### 6.1 The core insight (lead with this)
> Playwright's `getByRole`/`getByTestId` etc. **auto-wait and re-resolve** against the
> live DOM — so *executing* a known locator on a changing page is solved by the framework.
> What Playwright does **not** do is **author** a locator from intent, or **repair** a
> broken one. That authoring/repair slice is exactly where the AI + the validated
> inventory add value. So the AI is scoped to author + heal, not to re-implement waiting.

### 6.2 Why Claude Code (not the raw API)
**Locked decision: the app drives the Claude Code CLI headlessly**, authenticated by the
user's **existing Claude Code login** — no API key, no per-token billing. This is also
Playwright's officially-supported loop (`init-agents --loop=claude`). Trade-off: we give
up direct control of model/effort/caching knobs (Claude Code owns those) but gain
zero-key auth and a standard, portable loop. The grounding + self-heal + caps — the parts
that make output *reliable* — are all on our side.

### 6.3 The agent's tool surface (the grounding boundary)
The app ships an **MCP stdio server** (`src/mcp/server.js`) exposing 7 tools the agent
may call. The critical design choice: **the agent references elements by an inventory
`ref` (a number), never a raw selector** — so it physically *cannot* hallucinate a
selector. The server resolves the ref to a validated Playwright locator.

| Tool | Purpose |
|---|---|
| `navigate(url)` | go to an http(s) page (validated by `assertHttpUrl`) |
| `scan_page(filters?)` | scan the **current** page → ranked inventory `[{ref,name,role,locator,kind}]` |
| `list_reports` / `read_report` | optional pre-captured grounding handed off by the app |
| `act(locatorRef, action, value?)` | click/fill/check/uncheck/selectOption/submit |
| `assert(locatorRef, kind, expected?)` | visible/hidden/hasText/hasValue/checked |
| `write_spec(filename, content)` | write the final `.spec.ts` |

`src/mcp/page-session.js` holds **one long-lived page** across tool calls (the agent
navigates → scans → acts on the *same* page), injects the bundle, runs the readiness gate
before scans, and caches inventory per URL (marks dirty on `framenavigated`).

#### 6.3.1 "Structurally unable to hallucinate" — what this actually means

This is the single most important claim in the AI layer, so be precise about it.

**What hallucination means here.** Ask a plain LLM to "click the login button" and it
emits a selector from memory: `page.click('.btn-login-primary')`. It has never seen the
real DOM — it's pattern-matching what a selector *usually looks like*, so it invents a
plausible-but-maybe-nonexistent one. That confident, well-formed, points-at-nothing
selector is the hallucination, and it's the #1 cause of flaky LLM-generated tests.

**Why validation-after-the-fact isn't enough.** You could let the model emit selectors and
then check them — but it still *authored a guess*, and when the guess is wrong you're back
to it guessing again. The fix isn't checking harder; it's removing the ability to guess.

**The mechanism: the tool API has no slot for a selector.** Look at the `act` tool schema
in `src/mcp/server.js`:
```js
inputSchema: {
  locatorRef: z.number().int(),                 // ← a NUMBER, not a string
  action: z.enum(['click','fill','check','uncheck','selectOption','submit']),
  value: z.string().optional(),
}
```
The model literally *cannot* call `act({ selector: '.btn-login' })` — there is no
`selector` parameter, and `locatorRef` must be an integer. The only thing it can say is
*"act on element #7."* The number→locator mapping is owned by the **server**
(`bindRef(page, 7)` looks up `currentLocators[7]`), never the model. There is no syntactic
channel through which a hallucinated selector could enter.

Where the numbers come from: `scan_page` ran the real engine against the **live** DOM and
handed the model a validated menu (`inventoryView()`):
```
{ ref: 0, name: "Username", role: "input",  locator: "getByTestId('username')" }
{ ref: 7, name: "Sign in",  role: "button", locator: "getByRole('button',{name:'Sign in'})" }
```
The model reads that menu and points at a row. Its job is reduced from **invention** to
**selection**.

**Why "RAG for selectors" is the right analogy.** Retrieval-Augmented Generation kills
*factual* hallucination by the same move:
- ❌ "What's our refund policy?" → model invents an answer from training data.
- ✅ RAG: retrieve the real policy → model answers **only from retrieved text**, citing it.

Here: **retrieve** = `scan_page` extracts real validated locators (the corpus); **augment**
= the ref'd inventory is given to the model as context; **generate** = the model *selects*
a ref. The `ref` is exactly a **citation** — "per [ref 7]" instead of "per [source 3]." In
both systems the grounding source is the real thing, and the model can't produce a
citation-free claim / a selector-string.

**The honest caveat (say this before the interviewer asks).** Grounding eliminates
*invention*, not *misjudgment*:
- ✅ **Impossible:** a selector that doesn't exist or is brittle — there's no input field
  for one. A bad ref (`999`) fails safe: `bindRef` returns `{ ok:false }` and the tool
  errors rather than acting on the wrong thing.
- ⚠️ **Still possible:** the model picks the *wrong valid ref* — clicks "Cancel" (ref 8)
  when it meant "Submit" (ref 7). That's a **reasoning error**, not a hallucination. Every
  action is guaranteed to hit a *real, on-page* element; it is **not** guaranteed to hit
  the *semantically intended* one (assertions + heal catch some of this).

> **The tight one-liner:** *"The model can choose the wrong element, but it can't invent
> one. Tools accept a numeric ref into a DOM-validated inventory, never a selector string —
> so brittle/nonexistent selectors are structurally impossible, the same way RAG makes
> citation-free facts impossible."* That **selection-error-possible / invention-impossible**
> distinction is what makes the claim accurate instead of oversold.

### 6.4 The orchestration prompt (planner → generator → healer)
`.claude/skills/agentic-test-automation/orchestration.md` is the agent's operating manual
(injected via `--append-system-prompt-file`, and also shipped as a SKILL.md). It encodes:
1. **PLAN** — turn English into an ordered intent list (no selectors yet).
2. **GENERATE (live explore-and-author)** — `navigate` → `scan_page` → bind each intent to
   a `ref` → `act`/`assert`; **re-scan on every new page** (pages never seen upfront are
   discovered as the flow reaches them).
3. **WRITE** — assemble a clean Playwright spec from the locators that actually worked.
4. **HEAL** — on failure, re-scan + re-bind once, else report failed (never guess).

**Absolute rules** baked in: never invent a selector; re-scan after navigation; one action
at a time, observe result; let Playwright wait (no manual sleeps).

### 6.5 How the app drives it — `ai-manager.js`
```
spawn: claude -p "<task>"
  --output-format stream-json --verbose      # line-delimited JSON events
  --append-system-prompt-file orchestration.md
  --mcp-config <generated>.json --strict-mcp-config   # only our ata server
  --allowedTools "mcp__ata__*"                # no destructive tools
  --permission-mode dontAsk                   # non-interactive
```
- Writes the chosen Report to a **handoff JSON** the MCP server reads (grounding seed).
- Spawns with a **clean child env**: drops `ELECTRON_RUN_AS_NODE` (so the user's Claude
  login is used, not node mode), and sets `MAX_THINKING_TOKENS=0` (portability — see 6.7).
- **Parses stream-json** events (`system/init`, `assistant` text + `tool_use`, `user`
  tool_result, `result`) into normalized progress and pushes them to the renderer over IPC
  → the live per-step UI.

### 6.6 Tiered self-heal (cheapest-first)
In `server.js` `bindRef()`: when an action targets a `ref`, the server tries the element's
**ranked locators in order** and uses the first that resolves; `healed = i > 0` (true only
if it fell past the top-ranked one). So:
1. **Tier-1 (free, no AI):** next ranked locator from the inventory — absorbs most
   post-deploy churn with zero tokens.
2. **Tier-2 (one AI turn):** element gone → agent calls `scan_page` and re-binds by
   accessible name/role.
3. **Report, don't guess:** neither resolves → fail with a precise reason.

**Bug caught in verification:** the heal flag was originally `projected !== recommended`
(object identity), which was always true → every action falsely reported "healed." Fixed
to compare by **position** (`i > 0`). Found only by *running it and checking the flags* —
a good "I verify, I don't assume" story.

### 6.7 Reliability & cost levers we own (model-independent)

**Why it's cheap:**
- **No API key** — the app drives `claude -p` on the user's existing **Claude Code login**,
  so from the app's side there's no metered per-token bill (flat-rate subscription). The
  app adds no key and no billing of its own.
- **Extended thinking off** — `MAX_THINKING_TOKENS=0` ([ai-manager.js](../src/main/ai-manager.js))
  drops the priciest (thinking/output) tokens on every turn.
- **Grounding keeps prompts small** — the model never sees raw DOM; `inventoryView()` hands
  it a compact, recommended-only `{ref,name,role,locator}` menu, so input tokens per turn
  stay low.
- **Tier-1 heal costs zero tokens** — stale-locator fallbacks resolve **server-side** in
  `bindRef()`, no AI turn involved; this absorbs the most common failure (post-deploy churn).

**What stops it running forever / overspending — be precise about hard vs soft:**
- **Hard — per-run dollar cap (enforced by the CLI):** `--max-budget-usd` (default **$5**,
  override via `ATA_MAX_BUDGET_USD`). The CLI ends the run when spend hits the cap. Sized
  with large headroom — a verified run cost **< $0.10** and even a heavy enterprise
  multi-page flow (many scans/heals/retries, any browser — browser choice changes timing,
  not token cost) stays well under $1 — so it never trips a legitimate run, only a runaway.
- **Hard — wall-clock kill:** a 10-minute ceiling with SIGTERM→SIGKILL escalation
  guarantees the process always dies even if the agent wedges (`claude` spawns its own
  browser + MCP server, so the escalation matters).
- **Hard — restricted tool surface:** `--allowedTools mcp__ata__*` + `--strict-mcp-config`
  + `--permission-mode dontAsk` — the agent can call *only* our 7 MCP tools (no Bash, no web,
  no file sprawl), so it can't wander into expensive side-quests.
- **Hard — user Cancel:** an `AbortController` wired to SIGTERM kills a run on demand.
- **Soft — prompt discipline:** `orchestration.md` says "retry once then report failed,"
  "one action at a time." This trims waste but is model-obeyed, not enforced (there are no
  numeric step/heal/scan counters — the deterministic backstops are the dollar + time caps).
- **Readiness gate** before every scan — never bind a half-rendered DOM (accuracy, not cost,
  but it avoids wasted re-scan turns).

**Portability:** `MAX_THINKING_TOKENS=0` also makes the run work across first-party Claude,
Bedrock, and corporate LLM gateways (a real gateway rejected the `thinking` param; this
omits it). Found by a live run failing with a 400.

### 6.8 The generated output (what "good" looks like)
From a verified live run (login→dashboard, 2 pages, the dashboard never pre-scanned):
```js
// generated by Agentic Test Automation
import { test, expect } from '@playwright/test';
test('login flow', async ({ page }) => {
  await page.goto('http://.../');
  await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');
  await page.getByRole('textbox', { name: 'Password' }).fill('secret');
  await page.getByTestId('login-btn').click();          // healed: role→testid fallback fired
  await expect(page.getByTestId('orders-link')).toBeVisible();
});
```
Clean, standard Playwright using resilient role/test-id locators; **no rescan logic in the
test file** (that lives only in the authoring harness). Verified by *actually executing
it* — runs green.

---

## 7. Persistence (IndexedDB)

`src/renderer/infrastructure/idb-repository.js`, DB version 2, stores:
- `reports` (metadata) + `elements` (keyed by reportId — kept separate so the list stays
  light and elements load lazily on select)
- `ai_tests` — each AI run: `startUrl`, **`stepsText` (the English)**, `browserType`,
  grounding `reportId/label`, the generated `spec`, the run `transcript`, `success`,
  `durationMs`, `costUsd`
- `settings`, `profiles` (attribute profiles)

The v1→v2 upgrade is additive (guarded `contains` checks) — verified to preserve existing
reports while adding `ai_tests`. The renderer degrades gracefully if IndexedDB is
unavailable (warns, stays usable).

---

## 8. Security model (inherited from the reference architecture)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — renderer can't
  touch Node; all privileged ops go through the `contextBridge` preload allow-list.
- Custom `app://` protocol with **path containment** (`security/path-guards.js`) + a strict
  **CSP**; navigation away from the shell and `<webview>` attach are blocked.
- `assertHttpUrl` gates every navigation; `isBrowserDescriptorAllowed` validates a launch
  target against the trusted detection set; `isSafeBasename` guards export filenames.
- Packaging: electron-builder + **Electron fuses** (afterpack) — `RunAsNode` off, cookie
  encryption on, ASAR integrity, only-load-from-asar.

---

## 9. Build & tooling

- **4 webpack bundles**, each with a different target:
  - `webpack.main.config.js` → `electron-main` (dist/index.js, preload.js)
  - `webpack.renderer.config.js` → `web` (dist/renderer/*) + static-asset copy
  - `webpack.bundle.config.js` → `web` UMD (dist/tracker-bundle.js, the injected engine)
  - `webpack.mcp.config.js` → `node` (dist/mcp/server.js) + copies orchestration.md
- Node-only deps (`electron`, `playwright`, `electron-log`, MCP SDK) are **externals** in
  the bundles that shouldn't inline them; `_page_stubs_/` aliases neutralize Node modules
  in the injected page bundle.
- Cross-platform packaging: NSIS (Win) / DMG (mac) / AppImage+deb (Linux); Playwright
  browsers shipped via `extraResources`.

---

## 10. Data flow end-to-end (the full trace)

```
User (AI Automation tab): Start URL + browser + optional Report + English steps → Run
  │ IPC AI_RUN { startUrl, stepsText, browserType, reportElements }
  ▼
ai-manager: write handoff.json (grounding) → spawn `claude -p` (clean env, MAX_THINKING=0)
  │   --append-system-prompt-file orchestration.md  --mcp-config  --allowedTools mcp__ata__*
  ▼
Claude Code (agent loop):  plan intents
  │  navigate(url) ─► MCP server ─► its Playwright ─► real page
  │  scan_page()   ─► inject bundle ─► window.__elementTracker.scanPage ─► ranked inventory
  │  act(ref,…) / assert(ref,…)  (tier-1 heal in bindRef)
  │  detect navigation → scan_page() again  (explore-and-author across pages)
  │  write_spec(...)  ─► .spec.ts on disk
  │  (every event streamed back as stream-json)
  ▼
ai-manager parses stream-json → IPC AI_PROGRESS → renderer live log
  ▼
renderer: on finish, saveAiTest({stepsText, spec, transcript, success, …}) → IndexedDB
  → left-pane "AI Tests" list refreshes → details panel shows steps + spec + run log
```

---

## 11. Verification discipline (what I can defend with evidence)

Every layer was verified with **real output**, and live runs caught **real bugs**:
- MCP server end-to-end over stdio: list tools → navigate → scan → act → assert → write.
- **Live agent run PASS**: multi-page login flow, tier-1 heal fired, clean spec written —
  and the spec **actually executed green** (not just "looks right").
- Bugs found by verifying (not assuming): the thinking-param 400 on a Bedrock gateway
  (→ `MAX_THINKING_TOKENS=0`), the dev `dist` path resolution, the false-positive heal flag.
- IndexedDB: add/get/delete round-trip + v1→v2 upgrade preserving data — both PASS.

---

## 12. Interview Q&A — likely questions, crisp answers

**Q: Is it really an "agent," or just an LLM call?**
A: An agent — it's an LLM tool-use loop: Claude decides which tool to call (`scan_page`,
`act`, …), observes the real browser result, and adapts (re-scans on navigation, heals on
failure). Not one-shot generation. The authoring/run/heal loop is the agentic part;
re-running an already-generated test is just Playwright.

**Q: How do you stop the LLM from hallucinating selectors?**
A: I make it structurally impossible. The MCP tools only accept an inventory `ref` (a
number) produced by the validated live scan — there is no parameter to pass a raw selector,
so the model can't emit one. The server resolves the ref to a Playwright locator. This is
RAG-for-selectors: retrieve validated locators, the model only *chooses* (the ref is a
citation). Important nuance I'd add unprompted: this eliminates *invention*, not
*misjudgment* — the model can still pick the wrong *valid* ref (click Cancel instead of
Submit), which is a reasoning error, not a hallucination. Every action is guaranteed to hit
a real on-page element; it's not guaranteed to be the semantically right one. A bad ref
fails safe (`bindRef` returns `{ok:false}`, the tool errors). See §6.3.1.

**Q: A multi-page flow — how does it work if you only scanned the login page?**
A: Generation is a **live explore-and-author** loop. The agent scans each page the moment
it lands on it (driven by navigation detection), so pages never seen upfront are
discovered as the flow reaches them. The starting Report is a head-start, not a
requirement.

**Q: What happens when the page changes mid-run / a modal appears?**
A: For a *known* locator, Playwright's auto-wait + live locators handle it — we don't
re-implement that. For a *new* element the agent has never seen, it re-scans (navigation
or DOM-dirty trigger) and binds against the fresh inventory.

**Q: How does self-healing work and how do you keep it honest?**
A: Tiered, cheapest-first: (1) next ranked locator from the inventory, free; (2) re-scan +
re-bind via one AI turn; (3) report failed, never guess. The "healed" flag is true only
when a fallback past the top-ranked locator was used — I found and fixed a bug where it
was always true (identity vs. positional comparison).

**Q: Cost / how do you keep it cheap and bounded?**
A: Cheap: it runs on the user's Claude Code login (no API key / no metered bill from the
app), thinking is off (`MAX_THINKING_TOKENS=0`), grounding keeps prompts small (a compact
ref'd menu, never raw DOM), and tier-1 heals cost zero tokens (server-side fallback).
Bounded by **hard** backstops: a per-run **dollar cap** (`--max-budget-usd`, default $5,
sized with big headroom so it only catches runaways), a **10-min wall-clock kill**
(SIGTERM→SIGKILL), a **restricted tool surface** (only our 7 MCP tools — no Bash/web), and a
**Cancel** button. I'm precise here: the "retry once / one action at a time" limits live in
the prompt and are *soft* (model-obeyed); the deterministic guarantees are the dollar and
time caps, not step/heal counters. See §6.7.

**Q: Why Claude Code instead of the API?**
A: Zero-key auth on the user's existing subscription, and it's the officially-supported
agent loop. We keep the reliability levers (grounding, heal, caps) on our side, so the
quality doesn't depend on which Claude backend runs it.

**Q: Why three separate browser contexts?**
A: Process isolation. The renderer is sandboxed (no Node). The main process drives
Playwright for scans/recording. The MCP server is a separate process Claude Code spawns,
so it runs its own Playwright for the agent. Clean boundaries, no shared mutable state.

**Q: Biggest technical challenge?**
A: Making generation reliable across *unseen, changing* pages without the LLM guessing.
Solved by (a) the validated ranked inventory, (b) constraining the tool surface to refs,
(c) live re-scan on navigation, and (d) deferring execution-time waiting to Playwright
instead of reinventing it.

**Q: What would you do next?**
A: A standalone **Healer** for saved tests that break later (re-scan → re-map → patch),
auth/seed handling (`storageState`), assertion suggestions, and tuning the orchestration
prompt to cut redundant exploratory scans (a long run did several before concluding).

---

## 13. Honest status (say this plainly)

- **Built & verified:** the capture engine, all 3 capture modes, cross-OS/cross-browser
  Playwright control, Reports + multi-format export, the MCP server (7 tools + tier-1
  heal), the orchestration skill, `ai-manager` (headless Claude Code driver), the AI
  Automation tab, AI-test persistence + left-pane list/details — **and a live end-to-end
  agent run that generated a spec which executes green.**
- **Designed / next:** standalone Healer for already-saved tests, seed/auth, prompt-tuning
  for fewer exploratory scans.

Phrase in-progress work as "designing/building," never "shipped," for anything not on the
verified list above.
```
