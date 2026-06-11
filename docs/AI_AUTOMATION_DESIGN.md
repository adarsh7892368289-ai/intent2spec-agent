# AI Test Automation — NL → Playwright Design (v2)

> Status: **design proposal**, no implementation yet. Supersedes v1. Rewritten
> after researching Playwright's official **Test Agents** (planner / generator /
> healer), Playwright MCP, and Playwright's locator/auto-wait model, plus the
> Anthropic agent-design + prompt-caching guidance from the `claude-api` skill.
>
> Builds on what already exists in this repo: the three capture modes, the
> IndexedDB **Reports** model, the enriched-element schema, and
> `src/core/automation/` (locator + action projection).

---

## 0. What changed from v1 (and why)

The research surfaced one decisive fact: **Playwright already ships an official
agentic testing architecture** — three agents (🎭 *planner*, 🎭 *generator*,
🎭 *healer*) that produce human-readable markdown **specs**, executable **tests**, a
**seed test** for environment bootstrap, and a bounded **healing loop**. It's invoked
via `npx playwright init-agents` and runs on Claude (and other) loops over **Playwright
MCP**, which drives the browser through the **accessibility tree, not screenshots**.

That reframes our design from "invent an NL→test system" to:

> **Adopt Playwright's planner/generator/healer shape (so our output is the
> industry-standard structure testers already use), and differentiate with the one
> thing Playwright's agents lack — a pre-captured, validated, ranked locator
> inventory from our engine — so generation is grounded instead of live-guessed.**

Three corrections v1 got wrong, now fixed:

1. **Execution-time DOM dynamics are Playwright's job, not ours.** Auto-waiting +
   live locators already handle "page changed / element appeared" for any *known*
   locator. We do **not** build re-scan-on-navigation into running tests. (See §5.)
2. **You can't generate a multi-page test from one snapshot.** Generation is a
   **live, explore-and-author** session — scan each page *as the flow reaches it*;
   the snapshot is a head-start, the live page is truth. (See §4.)
3. **The AI's real, narrow value is at author + repair time** — intent→locator and
   broken-locator→new-locator — exactly the slice Playwright deliberately leaves to
   you and the slice commercial tools (testRigor, Functionize) actually compete on.

---

## 1. The problem & why this app wins

UI automation's three expensive pains: **authoring cost**, **flaky selectors**
(Playwright's docs: CSS/XPath "can break when the DOM structure changes"), and
**maintenance** after UI churn.

Our edge over both Playwright's own agents and codegen: those resolve a locator from
*whatever the live DOM happens to be at that instant*. Our capture engine has already
produced, per element, a **ranked set of validated locators** (testId → role+name →
label → text → CSS → XPath), each checked against the real DOM. So the generator
**picks a resilient locator from a known-good set** instead of betting on one live
read. That is the differentiator: **grounded generation**, and **better heals** (we
have the *next* ranked locator ready, for free).

---

## 2. The architecture — mirror Playwright's three agents

We implement the same three roles, on Claude, inside the desktop app, grounded on our
Reports. Same vocabulary testers already know.

```
            ┌──────────── PLANNER ────────────┐
 English +  │ English steps + (optional)      │   spec.md
 Report  ─► │ Report → explores → writes a    │ ─────────► human-readable plan
            │ markdown PLAN (scenarios/steps/  │            (editable, reviewable)
            │ expected results/data)          │
            └─────────────────────────────────┘
                        │
            ┌──────────── GENERATOR ──────────┐
 spec.md +  │ Walks the plan in a LIVE browser│   *.spec.ts
 Report  ─► │ page-by-page; binds each step to│ ─────────► runnable Playwright test
            │ a VALIDATED locator from the     │            (clean, standard, no
            │ live/Report inventory; verifies  │             rescan logic inside)
            │ selectors + assertions as it goes│
            └─────────────────────────────────┘
                        │
            ┌──────────── HEALER ─────────────┐
 failing    │ Replays failing steps, re-scans │   patched *.spec.ts
 test    ─► │ the live page, re-binds broken   │ ─────────► passing (or skipped if
            │ locator from fresh inventory,    │             feature genuinely broken)
            │ bounded retry loop               │
            └─────────────────────────────────┘
```

Why adopt their shape rather than invent ours:
- **Markdown spec as the intermediate** is the right idea — it's human-editable, it's
  the review/approval surface, and it decouples *intent* from *binding*. We keep it.
- **Seed test** bootstraps env (login, fixtures) so plans/tests start from a ready
  `page`. We adopt the concept (see §6).
- **One-to-one spec↔test mapping** keeps output auditable. We keep `// spec:` / `//
  seed:` header comments so our output is interchangeable with Playwright's.

What we add on top: **the Report-backed locator inventory** feeds all three agents, so
binding is grounded, and the healer always has ranked fallbacks.

---

## 3. End-to-end workflow (input → output)

**Input** (new **AI Automation** tab): Start URL · Browser (existing selector) ·
optional grounding **Report** · English steps.

```
PLAN     parse English → intent list → (explore if needed) → spec.md   [shown to user, editable]
GENERATE drive live browser through spec → bind each step to a validated
         locator, scanning each page as reached → record what worked → *.spec.ts
RUN      execute the generated test (standard Playwright auto-wait)     [live pass/fail]
HEAL     on failure: re-scan live page → re-bind → bounded retry        [patched test]
EXPORT   save spec.md + *.spec.ts; store as an "AI Test" record
```

**Output the user sees:** the editable **plan**, then a live **per-step run** (each row:
✓/✗, the chosen locator, the page it was on, when that page was scanned), a **verdict**
(`7/7 · 4 pages · 1 healed · 38s`), and **Export** (`.spec.ts` + `.md`).

---

## 4. Generation = live explore-and-author (the multi-page answer)

A Report is a snapshot of *one* page-state; a flow crosses many. So generation drives a
real browser and scans each page **just-in-time as it arrives** — exactly how a human
builds a test with codegen + the inspector.

```
goto(startUrl)
for each intent in plan:
   if page inventory stale → readinessGate() → scanPage() → cache by URL/state
   bind intent → validated locator      (role + accessible-name + text/test-id match)
      └─ ambiguous? ask Claude to pick from the fresh inventory   (AI only when needed)
   execute via Playwright (auto-wait)
   record {intent, locator, action, pass}
   page navigated / DOM-dirty? → mark stale
emit *.spec.ts = the transcript of locators that actually worked
```

- Pages never scanned upfront get scanned **the instant the flow walks into them** —
  so "I only scanned login" still yields a full multi-page test.
- A **Hybrid recording** (human already walked login→orders→confirm) pre-supplies those
  pages → fewer/zero live scans → faster, cheaper, more reliable. (See §7.)
- Re-scans use the engine's **readiness gate** (networkidle + DOM-stable) so we never
  bind against a half-rendered page.
- A small **per-page inventory cache** (URL/state → inventory) makes back-navigation free.

---

## 5. Execution is Playwright's job — we don't rebuild it

Critical scope boundary (the v1 mistake):

| Concern | Owner | We build? |
|---|---|---|
| Wait for element to appear / be actionable | Playwright **auto-wait** | No |
| Re-resolve locator after navigation mid-run | Playwright **live locators** | No |
| Retry assertions until true | Playwright **web-first assertions** | No |
| Ambiguous match → fail loudly | Playwright **strict locators** | No |
| **Author** a locator from intent on an unseen page | **us: AI + inventory** | **Yes** |
| **Repair** a locator that no longer resolves | **us: AI + fresh scan** | **Yes** |

The **exported `.spec.ts` contains zero rescan logic** — it's clean Playwright relying on
auto-wait. Re-scanning lives only in our *authoring* (generator) and *repair* (healer)
harness, never in the test file.

---

## 6. Seed test & auth (adopt Playwright's concept)

Login/fixtures shouldn't be re-derived by AI every run. We support a **seed**: a saved
"reach the starting state" step (or a Playwright `storageState` for auth). The
planner/generator start from the seeded `page`, so a test for "the orders flow" begins
already-logged-in. MVP: seed = "navigate to start URL (+ optional stored login)";
Phase 2: full `seed.spec.ts` import like Playwright's agents.

---

## 7. How the existing modes feed this

The three capture modes are the **grounding source**; richer grounding = fewer live
scans during generation. They are not changed.

| Mode | Grounding it provides | Effect on an AI run |
|---|---|---|
| **Element Scan** | one page fully mapped | seeds single-page flows / step 1 |
| **Interactions** | the exact elements a human touched, in order | a demonstrated path skeleton |
| **Hybrid** | **every page walked, pre-scanned, in sequence** | best case — may need *zero* live re-scans |

No Report at all also works (pure live discovery from the start URL). The modes feed the
AI; the AI never *requires* them.

---

## 8. Storage (reuse the Reports model; add one record type)

- **Reports** stay exactly as built: `reports` store (metadata) + `elements` store
  (keyed by `reportId`) in IndexedDB. The AI reads a report via existing
  `getReportElements()` → `buildAutomationPayload()` → grounding inventory.
- **New: AI Test record** — `{ id, name, startUrl, seedRef?, specMarkdown,
  steps[]{intent,locator,action,result}, scriptTs, lastRun{passed,healed,durationMs},
  reportId? }`. Either a new `ai_tests` store or a `type:'ai_test'` tag on the existing
  list. The plan (`spec.md`) and the test (`*.spec.ts`) are both persisted so the
  healer can replay and the user can re-export.
- **Per-page inventory cache** during a run is in-memory in `ai-manager`, discarded at
  run end (runtime aid, not persisted).

---

## 9. The AI layer — headless Claude Code (LOCKED: no API key)

The app does **not** call the Anthropic SDK with an API key. It drives the **Claude Code
CLI headlessly**, authenticated by the user's **existing Claude Code login** (same
subscription as an interactive session) — no key, no per-token billing. This is also
Playwright's officially-supported loop (`init-agents --loop=claude`).

**Prerequisite:** Claude Code installed and logged in (`claude` on PATH, `claude login`
done) on any machine that runs an AI automation. The app detects this and shows a clear
"Connect Claude Code" banner if missing. (Distribution to other testers = each needs the
same; acceptable for now.)

**How the app invokes it (main process, `ai-manager.js`):**
- Spawn `claude -p "<task>" --output-format stream-json --verbose --mcp-config <path>
  --allowedTools "<our MCP tools>" --bare` as a child process.
- `--bare` → reproducible: only our flags load, not whatever's in the cwd's `.claude/`.
- Parse the streamed JSON events (text deltas, tool calls, init/usage) and **push them to
  the renderer over IPC** → the live per-step UI (§3). Same streaming pattern as the
  existing scan/record progress.
- Auth is implicit (reads the user's Claude Code token); **the app never sees a key.**

**How the app exposes its capabilities — a bundled MCP server (stdio):**
- The app ships an **MCP stdio server** (`mcp-server.js`) exposing the Playwright/scan
  capabilities as tools. stdio (not HTTP) because the tools drive a long-lived headless
  browser the server owns.
- Tools — each dedicated so the harness gates/audits, and so the model picks a
  **validated locator by inventory ref, never a raw selector**:
  `navigate`, `scan_page` (→ ranked inventory), `list_reports` / `read_report`,
  `act` (click/fill/check/select), `assert`, `write_spec`.
- Backed by the existing `playwright-manager` (headless launch, scan) and
  `locator-projection`. Claude Code calls these tools; our server executes them in-app.

**Encoding planner / generator / healer — a Claude Code Skill:**
- Ship `.claude/skills/playwright-automation/` (SKILL.md + PLANNER/GENERATOR/HEALER
  guidance + an example spec). SKILL.md frontmatter `description` makes Claude Code
  auto-load the workflow; nested docs are read on demand. This is the right vehicle
  (skills = multi-step procedures), per Claude Code docs.

**Reliability levers we still own (independent of the model/loop):**
- **Grounding:** tools force locator-by-inventory-ref, so generation is grounded, not
  guessed — the core differentiator survives regardless of which Claude loop runs it.
- **Tiered self-heal** (§10) runs in *our* harness: try the next ranked inventory locator
  **before** asking Claude — most heals need no model turn at all.
- **Hard runaway backstops** (as built): a per-run **dollar cap** (`--max-budget-usd`,
  default $5) and a **10-min wall-clock kill** (SIGTERM→SIGKILL), plus a **restricted tool
  surface** (`--allowedTools mcp__ata__*`). These are the deterministic, model-independent
  guarantees. Per-run **numeric step/heal/scan counters were considered but not built** —
  the "retry once" limits currently live in the orchestration prompt (soft, model-obeyed).
- **Readiness gate** before every scan so the model only ever sees a settled DOM.

> Trade-off vs. raw API: we lose direct control of model/effort/prompt-caching knobs
> (Claude Code manages those), but we gain zero-key auth on the user's subscription and a
> standard, interoperable loop. The grounding + heal + caps — the parts that make output
> *reliable* — are all on our side and unaffected.

---

## 10. Healing — tiered, cheapest-first

On a locator failure (Playwright throws after auto-wait timeout):

1. **Inventory fallback (no AI):** retry with the element's next ranked locator
   (`recommended → fallback1 → fallback2`). Absorbs most post-deploy churn for free.
2. **Re-ground (one AI turn):** element gone → `rescan()` the live page → AI re-binds
   that step by role/accessible-name against the fresh inventory.
3. **Report, don't guess:** neither resolves → mark failed with a precise reason
   ("no element role=button name='Add to cart' after rescan"); healer may **skip**
   (Playwright's convention) if the feature looks genuinely broken. Never a
   silently-wrong selector. Every heal is recorded as UI-drift signal.

---

## 11. Build phases

**Phase 1 — Generate + Run (the demo core).**
- AI Automation tab (start URL · browser · optional Report · English steps).
- Planner → editable `spec.md`; Generator → live explore-and-author → `*.spec.ts`;
  Run with live per-step results; tier-1/tier-2 self-heal; Export; AI Test record.
- `ai-manager.js` (agentic loop) + `act/assert/rescan/navigate/finish` tools backed by
  `playwright-manager`; binding via existing `locator-projection`.

**Phase 2 — Healer + seed + polish.**
- Standalone Healer for a saved test that breaks later (replay → re-scan → re-bind →
  bounded loop → patched test or skip).
- Full `seed.spec.ts` / `storageState` auth seeding.
- Assertion suggestions; multi-tab flows; spec re-edit-and-regenerate.

---

## 12. Why this is a strong AI showcase

- **Grounded generation, not hallucination** — model constrained to a validated locator
  set (RAG-for-selectors); the most defensible part.
- **Standard, interoperable output** — same planner/generator/healer + markdown-spec +
  seed shape as Playwright's official agents, so output drops into real repos.
- **Complete, production-shaped Claude integration** — agentic tool-use loop, structured
  outputs, prompt caching, adaptive thinking, task budgets, tiered self-heal.
- **Solves the measured, expensive problem** — authoring + flakiness + maintenance —
  with an outcome a non-coder can drive end to end.

---

## 13. Decisions

**Locked:**
- **AI engine = headless Claude Code** (the `claude` CLI driven by the app), authed by the
  user's **existing Claude Code login** — *no API key, no per-token billing*. The app
  exposes its scan/Playwright capabilities via a bundled **MCP stdio server** and encodes
  planner/generator/healer as a **Claude Code Skill**; it streams the loop's JSON events
  into the in-app **AI Automation** tab. (See §9.) Prerequisite: Claude Code installed +
  logged in on the running machine.
- **Run browser = headless.** AI runs execute via headless Playwright (fast, CI-like,
  deterministic). Live per-step results stream into the app UI (§3); no visible browser
  window. (The headed window stays exclusive to the Interactions/Hybrid *capture* modes.)

**Still open (need your call before building):**
1. **Spec review gate** — pause after Planner for the user to edit `spec.md` before
   Generate (recommended — matches Playwright's flow), or one-shot English→test?
2. **MVP scope** — Phase 1 (Generate + Run + tier-1/2 heal) first, Healer/seed in
   Phase 2 — agreed?
3. **Run guardrail** — *resolved as built:* a per-run dollar cap (`--max-budget-usd`,
   default $5) + a 10-min wall-clock kill + a restricted tool surface, instead of numeric
   step/heal/scan counters (the "retry once" limit lives in the orchestration prompt).
4. **Output on disk** — write `specs/*.md` + `tests/*.spec.ts` to a user-chosen folder
   (Playwright-repo-compatible) in addition to the in-app AI Test record?
```

