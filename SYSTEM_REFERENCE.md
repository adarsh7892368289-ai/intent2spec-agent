# System Reference — Elements Tracker

> ⚠️ **Historical (Chrome-extension era).** The app is now an Electron + Playwright **desktop** application — see [README.md](README.md) and [CLAUDE.md](CLAUDE.md). The selector engine in `src/core/` is unchanged; extension-runtime details below (MV3 manifest, service worker, `chrome.*`) no longer apply.

**Version:** 3.0.0
**Manifest:** Chrome MV3 *(historical)*
**Runtime dependencies:** none

This document is the operational reference for the Elements Tracker extension. It describes the runtime architecture, data flow, tunable parameters, and observable behaviors of every subsystem. For engineering rationale, design decisions, and end-to-end walkthroughs, see [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md).

---

## 1. Overview

Elements Tracker is a content-script-driven Chrome extension that captures user interactions and full-page element scans, generates resilient XPath and CSS selectors per element, and persists enriched records to `chrome.storage.local`. It runs entirely client-side; no network egress is performed at any point in the data path.

The system is composed of three execution contexts with no shared memory, communicating exclusively through `chrome.runtime` messaging and `BroadcastChannel`/`postMessage`:

1. **Background service worker** — single instance, hibernation-aware, owns persistence and message routing.
2. **Content scripts** — injected into every frame (`all_frames: true`); capture user events, enrich elements, and coordinate cross-frame.
3. **Popup UI** — toolbar surface for mode selection, scan triggers, and export.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Chrome Extension Runtime                       │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────┐         ┌──────────────────────────┐    │
│  │  Background SW         │         │  Content Script (frame)  │    │
│  │  ─ MessageRouter       │◄───────►│  ─ Injector              │    │
│  │  ─ StorageController   │ runtime │  ─ EventManager          │    │
│  │  ─ SessionController   │ message │  ─ FrameChannel          │    │
│  │  ─ MemoryManager       │         │  ─ Capture modules       │    │
│  │  ─ BadgeController     │         │  ─ Enrichment pipeline   │    │
│  └────────────────────────┘         └──────────────────────────┘    │
│              ▲                                                       │
│              │ runtime message                                       │
│  ┌───────────┴────────────┐                                          │
│  │  Popup UI              │                                          │
│  │  ─ Mode / settings     │                                          │
│  │  ─ Scan trigger        │                                          │
│  │  ─ Export (JSON/CSV)   │                                          │
│  └────────────────────────┘                                          │
│                                                                      │
│  Shared infrastructure (importable by SW and content):               │
│  config · di-container · safe-execute · heuristics-engine ·          │
│  attribute-profiler · error-tracking · schemas · utils               │
└──────────────────────────────────────────────────────────────────────┘
```

### Background service worker

| Module | Responsibility |
|---|---|
| `service-worker.js` | Initialization orchestrator, frame injection, hibernation-aware state restoration |
| `message-router.js` | Central dispatcher for all runtime messages from popup and content scripts |
| `storage-controller.js` | Atomic persistence with version-stamped optimistic locking |
| `session-controller.js` | Tab → session ID mapping (in `chrome.storage.session`), TTL cleanup |
| `memory-manager.js` | Storage quota watchdog with 30-day incremental cleanup |
| `badge-controller.js` | Toolbar badge state (active vs. inactive) |

### Content script (per-frame)

| Module | Responsibility |
|---|---|
| `injector.js` | Bootstraps EventManager; queues runtime messages received before init completes |
| `core/event-manager.js` | Capture-module lifecycle, mode switch (CREATE/DESTROY pattern), frame routing |
| `helpers/frame-channel.js` | Same-origin (BroadcastChannel) and cross-origin (postMessage handshake) coordination |
| `capture/click-capture.js` | Passive document-level click listener with AbortController-based cleanup |
| `capture/input-capture.js` | Focus/blur delta capture with bounded active-input map (max 100 entries) |
| `capture/form-capture.js` | Submit listener with WeakMap deduplication |
| `capture/navigation-capture.js` | History API patch (idempotent), beforeunload, popstate, hashchange |
| `capture/scroll-capture.js` | 500 ms trailing throttle, 50 px minimum delta filter |
| `capture/page-scanner.js` | Full-page enumeration with optional scroll traversal and streaming enrichment |

### Enrichment pipeline (DI-resolved)

| Module | Responsibility |
|---|---|
| `enricher.js` | Pipeline orchestrator; per-element enrichment + adaptive batch enrichment |
| `xpath-engine.js` | 22-tier strategy tournament with `strictValidate`, `ensureUniqueness`, robustness scoring |
| `xpath-strategies.js` | All 22 stateless XPath strategy implementations |
| `xpath-shadow-handler.js` | Shadow-aware XPath/CSS composite generation for hosts and nested shadow trees |
| `css-engine.js` | 10-strategy CSS cascade, shadow-composite emission with cross-framework dialects |
| `css-shadow-strategies.js` | Shadow-root-scoped CSS selector strategies |
| `label-extractor.js` | 12-source label cascade with scroll-stable LRU cache (500 entries) |
| `parent-builder.js` | Ancestor walk (max depth 30), meaningful-parent filtering (max 5 retained) |
| `nearby-finder.js` | Spatial context discovery within 400 px, table-row prioritization |
| `metadata-collector.js` | Element metadata extraction with type-aware form-value handling |
| `description-builder.js` | Human-readable element descriptions |

### Shared infrastructure

| Module | Responsibility |
|---|---|
| `config.js` | Single source of truth for all tunables, message types, storage keys |
| `di-container.js` | Lazy DI container; breaks circular imports between engines and strategies |
| `safe-execute.js` | Timeout + circuit breaker + retry/backoff wrapper with transient-error classification |
| `heuristics-engine.js` | Adaptive timeout/concurrency based on DOM complexity and JS-heap pressure |
| `attribute-profiler.js` | Per-domain learning loop scoring attributes by uniqueness/coverage/temporal stability |
| `error-tracking.js` | Centralized error collection with deduplication and bounded LRU eviction |
| `schemas.js` | Element schema definitions and validators |
| `utils.js` | ID generation, timestamping, lightweight serialization helpers |

---

## 3. Tracking modes

| Mode | Active modules | Trigger |
|---|---|---|
| `interactions` (default) | Click, Input, Form, Navigation, Scroll | User events on the page |
| `full_page` | PageScanner only | Manual scan from popup |
| `hybrid` | All interactions + PageScanner; XPath-deduplicated on scan | Both |

Mode changes are processed through `EventManager.switchMode`, which destroys all capture modules, clears the page-context cache, waits 100 ms for DOM stability, then instantiates a fresh module set for the target mode. The CREATE/DESTROY pattern guarantees no listener leaks across mode boundaries.

---

## 4. Selector generation

### XPath tournament (22 tiers)

The XPath engine runs a tournament of strategies in tier order. Tiers 0–18 form the main loop; tiers 19–22 form a fallback batch invoked only when the main loop yields no valid candidates.

| Tier | Strategy | Example |
|------|----------|---------|
| 0 | exactVisibleText | `//button[text()="Submit"]` |
| 1 | testAttributes | `//input[@data-testid="email"]` |
| 2 | stableId | `//form[@id="login-form"]` |
| 3 | visibleTextNormalized | `//button[normalize-space()="Save"]` |
| 4 | precedingContext | `//label[@for="email"]/following-sibling::input[@type="email"]` |
| 5 | descendantContext | `//form[@id="login"]/descendant::input[@name="password"]` |
| 6 | attrTextCombo | `//button[@class="btn" and text()="Submit"]` |
| 7 | followingContext | `//*[@data-qa="submit"]/following::button` |
| 8 | frameworkAttrs | `//input[@data-aura-id="…"]` |
| 9 | multiAttrFingerprint | `//input[@type="text" and @name="email"]` |
| 10 | ariaRoleLabel | `//button[@role="button" and @aria-label="Save"]` |
| 11 | labelAssociation | `//label[@for="email"]/following-sibling::input` |
| 12 | partialTextMatch | `//button[contains(text(),"Sub")]` |
| 13 | hrefPattern | `//a[contains(@href,"/login")]` |
| 14 | parentChildAxes | `//form/child::input` |
| 15 | siblingAxes | `//label/following-sibling::input` |
| 16 | semanticAncestor | `//form/descendant::input[@name="email"]` |
| 17 | classAttrCombo | `//button[contains(@class,"btn") and @id="submit"]` |
| 18 | ancestorChain | `//form/fieldset/descendant::input` |
| 19 | tableRowContext (fallback) | `//tr[@data-row-id="123"]/descendant::input` |
| 20 | svgVisualFingerprint (fallback) | `//*[local-name()='svg'][@data-key="icon"]` |
| 21 | spatialTextContext (fallback) | `//span[text()="Email:"]/following::input` |
| 22 | guaranteedPath (fallback) | full ancestor chain with stable attributes |

**Tournament algorithm:**

1. Build all strategies for tiers 0–18.
2. For each strategy, generate candidates and validate via `strictValidate` (uniqueness + correct target via `document.evaluate`).
3. If a candidate matches multiple elements, `ensureUniqueness` attempts disambiguation by wrapping with ancestor / parent / sibling / full-attribute predicates.
4. Early exit after **3 valid candidates** or when elapsed time exceeds the adaptive timeout from the heuristics engine.
5. If the main loop yields zero valid candidates and remaining time exceeds 20 ms, run tiers 19–22 in parallel via `Promise.all`.
6. Sort surviving candidates by `tier` ascending, then `robustness` descending.
7. `selectDiverseFallbacks` deduplicates by XPath string and slices the top 3.

**Robustness scoring:** base = `100 − (tier × 4)`, with bonuses for stable test attributes, ARIA, IDs, and text predicates, and penalties for class-contains, axis traversals, and excessive path segments. Final value clamped to `[30, 100]`.

### CSS cascade (10 tiers)

The CSS engine runs strategies sequentially; the first strategy that yields a unique selector against the appropriate context (document or shadow root) wins.

| Tier | Strategy |
|------|----------|
| 1 | id selector |
| 2 | data attributes |
| 3 | combined data attributes |
| 4 | type + name (form fields) |
| 5 | class attribute |
| 6 | parent > child combinator |
| 7 | descendant combinator |
| 8 | pseudo-classes (`:disabled`, `:required`, `:checked`) |
| 9 | nth-child |
| 10 | nth-of-type |

### Shadow DOM composite

Elements inside a shadow root receive a CSS shadow-composite selector instead of XPath (XPath cannot cross shadow boundaries via `document.evaluate`). The composite shape:

```javascript
{
  type: 'shadow-composite-css' | 'shadow-composite-css-nested',
  hostSelector,         // single-level
  hostChain,            // nested
  internalSelector,
  shadowDepth,
  framework,
  toString(),           // 'host >> internal'
  execute(rootDocument), // traverses host chain, returns element
  playwright,           // 'host >>> internal'
  selenium,             // 'host::shadow internal'
  cypress               // host only
}
```

Closed shadow roots are accessed via `ShadowDOMTraverser.tryAccessClosedShadowRoot`, which uses framework heuristics (Salesforce Lightning, Aura, LWC). Frameworks outside the recognized list fall back to host-only CSS.

---

## 5. Enrichment pipeline

### Per-element flow (`enrichElement`)

1. Event-based fast path — captures of type `navigation` or `scroll` return a minimal record (id, timestamp, url, sessionId, captureMode, captureType, eventData) with no selectors, labels, or hierarchy.
2. Detached-element check via `element.isConnected`.
3. Shadow context resolution via `ShadowDOMTraverser.getShadowPath`.
4. Visibility check (interactions mode skips invisible elements).
5. Adaptive timeout computation via `heuristicsEngine.computeEnrichmentTimeout`.
6. Engine pass under `safeExecute` with per-call timeout `min(parallelTimeout, enrichmentTimeout / 2)`:
   - XPath generation
   - CSS generation
   - Label extraction (LRU lookup first)
   - Parent hierarchy
   - Metadata collection
7. Sequential pass: nearby-element discovery, description building.
8. Bounding-rect to page coordinates.
9. Selector serialization (shadow composites stringified via `toString()`).
10. Display-name vs. label deduplication.
11. `compressElement` strips nullable fields and caps bounded arrays.

Engines that exceed their timeout return their fallback value; one slow strategy never blocks subsequent enrichment work.

### Batch flow (`batchEnrichElements`)

1. Filter detached elements.
2. Compute adaptive concurrency via `heuristicsEngine.computeBatchConcurrency`.
3. Process batches with `Promise.all`, yielding between batches via `requestIdleCallback` (1000 ms idle deadline).
4. Dispatch `enrichment-batch-complete` and `page-scan-partial` events for streaming consumers.

---

## 6. Adaptive heuristics

The heuristics engine probes DOM complexity (`document.querySelectorAll('*').length`), shadow-root count, and JS-heap pressure (`performance.memory.usedJSHeapSize / jsHeapSizeLimit`). The probe is cached on a monotonic clock (`performance.now()`) for 5 seconds; navigation captures explicitly invalidate the cache on every route change.

### Enrichment timeout

| Input | Adjustment |
|---|---|
| DOM nodes > 10 000 | timeout = 300 ms |
| DOM nodes > 2 000 | timeout = 200 ms |
| DOM nodes > 500 | timeout = 150 ms |
| DOM nodes > 100 | timeout = 125 ms |
| Shadow roots > 10 | × 1.30 |
| Shadow roots > 5 | × 1.15 |
| JS heap > 85 % | × 0.50 |
| JS heap > 70 % | × 0.75 |

Final value clamped to `[50, 300] ms`. Base = `ENRICHMENT_CONFIG.MAX_ENRICHMENT_TIME` (100 ms).

### Batch concurrency

| Input | Adjustment |
|---|---|
| DOM nodes > 10 000 | concurrency = 5 |
| DOM nodes > 2 000 | concurrency = 10 |
| DOM nodes > 500 | concurrency = 12 |
| JS heap > 90 % | ÷ 3 |
| JS heap > 80 % | ÷ 2 |

Final value clamped to `[3, 20]`. Base = `ENRICHMENT_CONFIG.BATCH_CONCURRENCY` (15).

---

## 7. Label extraction

The label extractor combines twelve sources and selects a display name in priority order. Results are cached in an LRU keyed by tag, id, classes, parent id, page coordinates (scroll-independent), and a 30-character text prefix.

| Source | Description |
|---|---|
| `aria-label` | Direct ARIA label |
| `aria-labelledby` | Resolves the referenced element's text |
| Associated `<label>` | `<label for>`, parent `<label>`, or preceding sibling `<label>` |
| Visible text | Direct text for `<button>`, `<a>`, button-type inputs |
| `placeholder` | Form-field hint |
| `title` | Tooltip text |
| `value` | Button-type input value |
| `alt` | Image alt text |
| `name` | Form-field name (Title-cased) |
| `data-label` / `data-name` | Custom label attributes |
| Nearby `<label>` | Spatial heuristic within 100 px |
| Fallback | Role / type / tag mapping |

Cache size is 500 entries with LRU eviction. The cache is cleared on navigation, mode switch, and `pagehide`.

---

## 8. Parent hierarchy

`parent-builder.js` walks up to 30 ancestor levels and retains up to 5 meaningful parents. Meaningful parents include semantic tags (`form`, `nav`, `header`, `section`, `article`, etc.), elements with stable IDs or `data-*` attributes, custom elements (tag containing `-`), and elements with component-style classes (BEM `__` / `--`). Shadow hosts are included when the target lives inside a shadow tree.

The result includes a structured `parents[]` array, a `fullDomPath` string for human reading, and an absolute `depth`.

---

## 9. Nearby-element context

`nearby-finder.js` discovers up to four contextual neighbors (one per cardinal direction) within `CONTEXT_CONFIG.SEARCH_RADIUS = 400` px. Candidates are scored by:

- Test attributes (`data-testid`, `data-qa`): +20
- Stable ID: +15
- `<a href>`: +10
- `data-*` attributes: +8
- ARIA attributes: +6
- `name` attribute, valid text content, button/input tags: +5 each

When the target is inside a `<table>`, candidates in the same `<tr>` receive a `+CONTEXT_CONFIG.SAME_ROW_PRIORITY_BOOST = 500` bonus to surface row-context labels.

---

## 10. Storage and persistence

### Storage keys (`chrome.storage.local`)

| Key | Shape | Purpose |
|---|---|---|
| `interactions_elements` | `EnrichedElement[]` | Captures from interactions mode |
| `fullpage_elements` | `EnrichedElement[]` | Element-scan captures |
| `hybrid_elements` | `EnrichedElement[]` | Hybrid-mode captures, deduplicated by primary XPath |
| `interactions_stats` | counters object | Aggregate counts per capture type |
| `fullpage_stats` | counters object | Scan counts |
| `hybrid_stats` | counters object | Combined counters |
| `settings` | `DEFAULT_SETTINGS` shape | User preferences |
| `trackingState` | boolean | Active vs. paused |
| `_version` | number | Optimistic-lock counter |
| `_writerId` | string | Write provenance for debugging |
| `domain_attribute_profiles` | `{ [domain]: ProfileObject }` | Per-domain learned XPath attributes (TTL 7 days) |

### Session-scoped (`chrome.storage.session`, clears on browser close)

| Key | Shape | Purpose |
|---|---|---|
| `active_sessions_map` | `{ [tabId]: SessionData }` | Tab → session ID mapping |
| `injected_frames_set` | `string[]` | `${tabId}-${frameId}` keys; survives SW hibernation |

### Atomic update protocol

`StorageController.atomicUpdate` implements optimistic locking:

1. Quota check — abort if usage exceeds `STORAGE_LIMITS.CRITICAL_THRESHOLD` (90 % of 50 MB).
2. Read current value plus `_version`.
3. Apply the updater function to compute the new value.
4. Write `{ ...updates, _version: prev + 1, _writerId }`.
5. Re-read `_version` to confirm the write was not overwritten by a concurrent writer.
6. On version mismatch, retry with exponential backoff plus jitter.

| Parameter | Value |
|---|---|
| `RETRY_CONFIG.MAX_ATTEMPTS` | 5 |
| `RETRY_CONFIG.BASE_DELAY_MS` | 50 |
| `RETRY_CONFIG.BACKOFF_MULTIPLIER` | 2 |
| `RETRY_CONFIG.JITTER_FACTOR` | 0.3 |
| `RETRY_CONFIG.MAX_DELAY_MS` | 5 000 |
| `STORAGE_LIMITS.QUOTA_BYTES` | 52 428 800 (50 MB) |
| `STORAGE_LIMITS.WARNING_THRESHOLD` | 0.8 |
| `STORAGE_LIMITS.CRITICAL_THRESHOLD` | 0.9 |
| `STORAGE_LIMITS.VERSION_RESET_THRESHOLD` | 1 000 000 000 |

### Memory manager

`memory-manager.js` runs a 30-second monitoring interval:

- `> 50 %` heap usage logs a compression-opportunity hint (no-op placeholder).
- `> 80 %` heap usage triggers `triggerTimeBasedCleanup()`, which removes records older than 30 days in batches of 1 000 entries per invocation. The cleanup index is persisted across calls so cleanup resumes from the last position rather than restarting.

---

## 11. Cross-frame coordination

`frame-channel.js` provides parent/iframe coordination across both same-origin and cross-origin frames.

### Channels

| Path | Use case | Mechanism |
|---|---|---|
| `BroadcastChannel('elements-tracker-frames')` | Same-origin frames | Single channel name, multicast |
| `postMessage` with handshake | Cross-origin frames | `CONNECT_OFFER` → `CONNECT_ACCEPT` → `CONNECT_ACK` |

Cross-origin detection: attempt to read `top.location.origin` and catch `SecurityError` ([frame-channel.js:198](src/content/helpers/frame-channel.js#L198)).

### Connection lifecycle

States: `UNINITIALIZED` → `PARENT_READY` / `WAITING` → `CONNECTED` ↔ `DISCONNECTED` → `ERROR` / `FAILED` / `IGNORED`.

### Health monitoring

| Parameter | Value |
|---|---|
| `FRAME_CHANNEL_CONFIG.PING_INTERVAL` | 15 000 ms |
| `FRAME_CHANNEL_CONFIG.PONG_TIMEOUT` | 10 000 ms |
| `FRAME_CHANNEL_CONFIG.MAX_MISSED_PONGS` | 5 |
| `FRAME_CHANNEL_CONFIG.CONNECTION_TIMEOUT` | 8 000 ms |
| `FRAME_CHANNEL_CONFIG.MAX_HANDSHAKE_RETRIES` | 5 |

### Message types

`CONNECT_OFFER`, `CONNECT_ACCEPT`, `CONNECT_ACK`, `CONNECTION_REJECTED`, `ELEMENT_CAPTURED`, `SCAN_REQUEST`, `SCAN_COMPLETE`, `MODE_CHANGED`, `TRACKING_STARTED`, `TRACKING_STOPPED`, `PING`, `PONG`, `IFRAME_READY`.

### Noise filter

Known ad / analytics iframes (DoubleClick, Google Ads, Google Tag Manager, Google Analytics, Facebook tracking pixel, Adservice, Scorecardresearch, Quantserve, Moatads, generic `analytics`, `pixel`, `tracking`) are filtered before any handshake to bound message volume.

---

## 12. Resilience layer

`safe-execute.js` provides a unified wrapper around timeout, retry, and circuit-breaker semantics.

### Functions

| Function | Behavior |
|---|---|
| `safeExecute(fn, options)` | Single attempt with timeout and fallback |
| `safeExecuteWithRetry(fn, fallback, options)` | Retry-with-backoff for storage and other transient-error-prone operations |
| `safeExecuteAll(promises, options)` | Parallel execution with per-promise timeout |

### Circuit breaker (per `operationName`)

| State | Behavior |
|---|---|
| `CLOSED` | Normal execution |
| `OPEN` | Returns fallback immediately; transitions to `HALF_OPEN` after cooldown |
| `HALF_OPEN` | Allows up to `halfOpenMaxCalls` probes; success → `CLOSED`, failure → `OPEN` |

| Parameter | Value |
|---|---|
| `CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD` | 5 |
| `CIRCUIT_BREAKER_CONFIG.SUCCESS_THRESHOLD` | 2 |
| `CIRCUIT_BREAKER_CONFIG.TIMEOUT_MS` | 60 000 |
| `CIRCUIT_BREAKER_CONFIG.HALF_OPEN_MAX_CALLS` | 3 |

### Transient-error classification

`TRANSIENT_ERROR_PATTERNS` = `/timeout/i`, `/network/i`, `/fetch.*failed/i`, `/temporarily unavailable/i`, `/ECONNREFUSED/i`, `/ETIMEDOUT/i`, `/temporarily locked/i`, `/rate limit/i`. Errors matching these patterns trigger retry; permanent errors (syntax, type, permission) fail fast.

---

## 13. Attribute profiler

`attribute-profiler.js` learns which attributes are most useful for selector generation on a given domain. It samples interactive elements, scores each candidate attribute, and stores the top scorers per domain.

### Sampling

```
sampleSize = min(MAX_SAMPLE_SIZE=1000,
                 max(MIN_SAMPLE_SIZE=100,
                     allElements.length * SAMPLE_PERCENTAGE=0.2))
```

Stratified by tag and component family to ensure framework-specific elements (Lightning, Aura, LWC, ng-reflect, v-bind) receive proportional representation.

### Scoring

```
score = 0.6·uniquenessRate + 0.2·temporalScore + 0.15·frameworkScore + 0.05·coverage
```

| Component | Description |
|---|---|
| `uniquenessRate` | Fraction of sampled elements where the attribute's value is unique within the page |
| `coverage` | Fraction of sampled elements that carry the attribute |
| `temporalScore` | 0.2 for names matching `/session\|timestamp\|nonce\|temp\|random\|dynamic\|uid-\d+\|ember\d+\|react\d+\|rendered\|cache/i`, else 0.9 |
| `frameworkScore` | 1.0 for stable Aura / LWC / ng-reflect / v-* patterns; 0.1 for React- and Angular-generated IDs (`data-reactid`, `_ngcontent-xxx-N`) |

### Filters

Attributes must satisfy `uniquenessRate ≥ 0.8` AND `coverage ≥ 0.03` to qualify. The top 15 attributes per domain are persisted.

### Profile lifecycle

| Parameter | Value |
|---|---|
| `PROFILER_CONFIG.MAX_PROFILES` | 500 |
| `PROFILER_CONFIG.PROFILE_TTL_DAYS` | 7 |
| Eviction batch size | 50 oldest profiles |

`XPathEngine.collectStableAttributes` merges learned attributes ahead of the static priority list before each tournament.

---

## 14. Configuration reference

All tunables live in `src/shared/config.js`. Selected high-impact parameters:

```javascript
ENRICHMENT_CONFIG = {
  MAX_ENRICHMENT_TIME: 100,           // base timeout, scaled by heuristics
  PARALLEL_TIMEOUT: 50,
  MAX_BATCH_TIME: 60000,
  BATCH_CONCURRENCY: 15,
  SKIP_INVISIBLE_IN_INTERACTIONS: true,
  ENABLE_PAGE_CONTEXT_CACHE: true,
  CACHE_EXPIRY_MS: 60000,
  MAX_PARENTS: 3,
  MAX_LABEL_LENGTH: 100,
  MAX_CLASSES_PER_ELEMENT: 2
};

LABEL_CACHE_CONFIG = {
  ENABLED: true,
  MAX_SIZE: 500,
  EVICTION_POLICY: 'LRU'
};

CONTEXT_CONFIG = {
  ENABLED: true,
  SEARCH_RADIUS: 400,
  MAX_ELEMENTS: 4,
  MAX_PARENT_DEPTH: 7,
  ENABLE_TABLE_AWARENESS: true,
  SAME_ROW_PRIORITY_BOOST: 500
};

STREAMING_CONFIG = {
  ENABLED: true,
  USE_IDLE_CALLBACK: true,
  IDLE_CALLBACK_TIMEOUT: 1000,
  PARTIAL_RESULT_EVENTS: true
};

SESSION_CONFIG = {
  TTL_MS: 24 * 60 * 60 * 1000,
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000
};

ERROR_TRACKING_CONFIG = {
  MAX_ERROR_HISTORY: 1000,
  MAX_ERRORS_BY_CODE: 100,
  MAX_ERRORS_BY_SESSION: 1000,
  DEDUPLICATION_WINDOW_MS: 5000
};
```

To enable verbose logging, set `GLOBAL_DEBUG = true` at the top of `config.js` and rebuild. Per-module overrides are available via `MODULE_DEBUG` constants in each file.

---

## 15. Message API

Runtime messages dispatched by `MessageRouter`:

| Type | Direction | Payload | Response |
|---|---|---|---|
| `GET_SESSION` | content → SW | `{ url }` | `{ success, sessionId }` |
| `GET_SETTINGS` | popup / content → SW | – | `{ success, settings }` |
| `UPDATE_SETTINGS` | popup → SW | `{ settings }` | `{ success }` + broadcasts `MODE_CHANGED` to tabs if mode changed |
| `INTERACTION` | content → SW | `{ data: EnrichedElement }` | `{ success }` or `{ success: false, reason }` |
| `PAGE_SCAN` | content → SW | `{ data: { elements, statistics, isMainFrameScan?, isIframeScan? } }` | `{ success }` |
| `GET_ELEMENTS` | popup → SW | `{ mode }` | `{ success, elements }` |
| `GET_STATS` | popup → SW | `{ mode }` | `{ success, stats }` |
| `CLEAR_BY_MODE` | popup → SW | `{ mode }` | `{ success }` |
| `CLEAR_ALL_MODES` | popup → SW | – | `{ success }` |
| `TOGGLE_TRACKING_STATE` | popup → SW | `{ isTracking }` | `{ success }` |
| `GET_MEMORY_USAGE` | popup → SW | – | `{ success, usage }` |
| `MODE_CHANGED` | SW → content | `{ mode }` | – (broadcast) |
| `TRACKING_STATE_CHANGED` | popup → tab content | `{ isTracking }` | – |
| `START_PAGE_SCAN` | popup → tab content | `{ filters }` | – |

All handlers are wrapped in try/catch and return `{ success: false, error: error.message }` on failure.

### State semantics

The popup stores `trackingState` in `chrome.storage.local` as `true = active` / `false = paused`. The MessageRouter holds an inverted in-memory boolean `isTrackingPaused`; the inversion ensures that an absent key (`undefined !== false`) defaults to "active", which is the correct behavior for fresh installs and post-clear states. All four contexts (popup, badge, service worker init, MessageRouter) read and write the same canonical key via `STORAGE_KEYS.TRACKING_STATE`.

---

## 16. Observability

### CustomEvents (window-scope)

| Event | Emitted by | Payload |
|---|---|---|
| `interaction-captured` | Capture modules | `{ data: EnrichedElement }` |
| `tracker-error` | Any module via `error-tracking.js` | `{ code, message, context }` |
| `page-scan-completed` | PageScanner | `{ elements, statistics }` |
| `page-scan-partial` | Streaming enrichment | `{ batch, total, completed }` |
| `enrichment-batch-complete` | Batch enricher | `{ count, elapsedMs }` |
| `flush-pending-inputs` | NavigationCapture | – (drains pending input deltas) |

### Error codes

| Code | Description | Recovery |
|---|---|---|
| `ENRICHMENT_INVALID_ELEMENT` | Element null or detached | Skip, log |
| `ENRICHMENT_DETACHED` | Element became detached during enrichment | Return null (non-fatal) |
| `ENRICHMENT_SELECTOR_FAILED` | Selector generation timeout | Fall back to lower-tier candidate |
| `XPATH_GENERATION_FAILED` | Strategy threw | Skip to next tier |
| `CSS_GENERATION_FAILED` | Strategy threw | Fall back to tag selector |
| `ENRICHMENT_TIMEOUT` | Batch exceeded `MAX_BATCH_TIME` | Skip remaining elements |
| `STORAGE_QUOTA_EXCEEDED` | `chrome.storage.local` over quota | Trigger cleanup, retry |
| `STORAGE_LOCK_TIMEOUT` | All retries exhausted | Surface error to caller |
| `FRAME_INIT_ERROR` | Frame channel init failed | Continue without cross-frame coordination |

### Error tracker

`error-tracking.js` deduplicates errors by `(code, message)` with bounded LRU eviction:

| Parameter | Value |
|---|---|
| `MAX_ERROR_HISTORY` | 1 000 |
| `MAX_ERRORS_BY_CODE` | 100 |
| `MAX_ERRORS_BY_SESSION` | 1 000 |
| `DEDUPLICATION_WINDOW_MS` | 5 000 |

Each tracked error retains first-seen timestamp, last-seen timestamp, and an occurrence counter.

---

## 17. Build and deployment

### Build

```bash
npm install
npm run build       # production
npm run dev         # watch mode with source maps
```

`webpack.config.js` produces three entry bundles in `dist/` with no chunking (MV3 service workers do not support dynamic `import()`):

- `dist/background/service-worker.js`
- `dist/content/injector.js`
- `dist/popup/popup.js`

Plus copies of `manifest.json`, `popup.html`, `popup.css`, and `icons/`.

### Browser target

Chrome 88+ via Babel `preset-env`. Minification via TerserPlugin (drops `debugger`, retains `console.*` for field diagnostics).

### Manifest permissions

`activeTab`, `storage`, `unlimitedStorage`, `tabs`, `webNavigation`, `scripting`, plus host permission `<all_urls>`. Exports use `URL.createObjectURL` + anchor click, so `chrome.downloads` is not required.

### Deployment

Load the `dist/` directory unpacked via `chrome://extensions` (Developer mode), or package as `.crx` for Chrome Web Store distribution.

---

## 18. File map

```
src/
├── shared/
│   ├── config.js                      tunables, message types, storage keys
│   ├── di-container.js                lazy DI for enrichment engines
│   ├── safe-execute.js                timeout + circuit breaker + retry
│   ├── heuristics-engine.js           adaptive timeout / concurrency
│   ├── attribute-profiler.js          per-domain attribute learning
│   ├── error-tracking.js              deduplicated error log
│   ├── schemas.js                     element schema + validators
│   └── utils.js                       id, timestamp, helpers
│
├── background/
│   ├── service-worker.js              init orchestrator + frame injector
│   ├── message-router.js              runtime-message dispatcher
│   ├── storage-controller.js          atomic update with optimistic locking
│   ├── session-controller.js          tab → session map
│   ├── memory-manager.js              quota watchdog + 30-day cleanup
│   └── badge-controller.js            toolbar badge state
│
├── content/
│   ├── injector.js                    bootstraps content-script subsystem
│   ├── core/
│   │   └── event-manager.js           capture-module lifecycle
│   ├── capture/
│   │   ├── click-capture.js
│   │   ├── form-capture.js
│   │   ├── input-capture.js
│   │   ├── navigation-capture.js
│   │   ├── scroll-capture.js
│   │   └── page-scanner.js
│   ├── enrichment/
│   │   ├── enricher.js                per-element + batch pipeline
│   │   ├── xpath-engine.js            22-tier tournament
│   │   ├── xpath-strategies.js        all 22 strategy implementations
│   │   ├── xpath-shadow-handler.js    shadow-aware composite XPath
│   │   ├── css-engine.js              10-tier CSS cascade
│   │   ├── css-shadow-strategies.js   shadow-scoped CSS strategies
│   │   ├── label-extractor.js         12-source label cascade
│   │   ├── parent-builder.js          ancestor walk + filtering
│   │   ├── nearby-finder.js           spatial context
│   │   ├── metadata-collector.js      attribute + form-value extraction
│   │   └── description-builder.js     human-readable descriptions
│   └── helpers/
│       ├── dom-utils.js               null-safe DOM interrogation
│       ├── visibility-checker.js      visibility + interactability
│       ├── shadow-dom-traverser.js    shadow path + framework heuristics
│       ├── frame-channel.js           cross-frame protocol
│       ├── enrichment-utils.js        page-context cache + sanitization
│       ├── text-utils.js              text normalization
│       ├── xpath-utils.js             XPath validation
│       └── css-utils.js               CSS escaping + match counting
│
└── popup/
    ├── popup.html
    ├── popup.css
    ├── popup.js                       PopupController + 2 s stats poll
    └── export-manager.js              JSON + CSV export (with redaction)
```

---

*This reference describes runtime behavior at the present version. For design rationale and architectural trade-offs, see [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md).*
