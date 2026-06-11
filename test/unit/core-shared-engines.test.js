import { describe, it, expect, vi, beforeEach } from 'vitest';

import { heuristicsEngine } from '@core/shared/heuristics-engine.js';
import { DIContainer } from '@core/shared/di-container.js';
import { ErrorTracker, TrackerError, ERROR_CODES } from '@core/shared/error-tracking.js';
import { ERROR_TRACKING_CONFIG } from '@core/shared/config.js';

// ---------------------------------------------------------------------------
// HeuristicsEngine.computeEnrichmentTimeout / computeBatchConcurrency
//
// These reference document/performance.memory inside estimateDOMComplexity and
// estimateMemoryPressure. The brief marks them pure-unit: we stub those two
// instance methods via vi.spyOn so the suite runs in the node environment with
// deterministic complexity / pressure inputs. Bounds: timeout [50,300],
// concurrency [3,20]; base timeout=100, base concurrency=15.
// ---------------------------------------------------------------------------
describe('HeuristicsEngine.computeEnrichmentTimeout', () => {
  beforeEach(() => {
    // Reset feature flags + caches mutated by individual tests; restoreAllMocks
    // (global afterEach) already undoes spies, but flags are plain state.
    heuristicsEngine.featureFlags.enableAdaptiveTimeout = true;
    heuristicsEngine.featureFlags.enableAdaptiveConcurrency = true;
    heuristicsEngine.featureFlags.enableMemoryPressureDetection = true;
    heuristicsEngine.featureFlags.enableShadowComplexityScoring = true;
    heuristicsEngine.clearCache();
    // Default: no memory pressure so it never perturbs complexity-only assertions.
    vi.spyOn(heuristicsEngine, 'estimateMemoryPressure').mockReturnValue(0.5);
  });

  it('returns base timeout (100) for simple page (domNodeCount below light threshold)', () => {
    expect(heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 50 })).toBe(100);
  });

  it('scales to 125 for light complexity (>100 nodes)', () => {
    expect(heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 300 })).toBe(125);
  });

  it('scales to 150 for medium complexity (>500 nodes)', () => {
    expect(heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 1500 })).toBe(150);
  });

  it('scales to 200 for complex pages (>2000 nodes)', () => {
    expect(heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 5000 })).toBe(200);
  });

  it('scales to 300 for very complex pages (>10000 nodes)', () => {
    expect(heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 50000 })).toBe(300);
  });

  it('timeout increases monotonically with DOM complexity', () => {
    const simple = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 10 });
    const light = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 200 });
    const medium = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 1000 });
    const complex = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 3000 });
    const veryComplex = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 20000 });
    expect(simple).toBeLessThan(light);
    expect(light).toBeLessThan(medium);
    expect(medium).toBeLessThan(complex);
    expect(complex).toBeLessThan(veryComplex);
  });

  it('domNodeCount=0 falls back to estimateDOMComplexity (node: no document → 500 fallback → light tier 125)', () => {
    // 0 is falsy, so it calls estimateDOMComplexity(). In node there is no
    // document → that method catches the ReferenceError and returns its 500
    // fallback. 500 > light(100) but not > medium(500) → 125ms.
    const t = heuristicsEngine.computeEnrichmentTimeout({});
    expect(t).toBe(125);
  });

  it('estimateDOMComplexity fallback (500) produces a deterministic light-tier timeout', () => {
    vi.spyOn(heuristicsEngine, 'estimateDOMComplexity').mockReturnValue(500);
    const t = heuristicsEngine.computeEnrichmentTimeout({});
    expect(t).toBe(125);
  });

  it('adds 30% overhead when shadowRootCount > 10', () => {
    // medium base = 150; *1.3 = 195
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 1500, shadowRootCount: 12 });
    expect(t).toBe(195);
  });

  it('adds 15% overhead when shadowRootCount > 5 (and <=10)', () => {
    // medium base = 150; *1.15 = 172.5 → round 173
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 1500, shadowRootCount: 7 });
    expect(t).toBe(173);
  });

  it('shadow overhead is capped at max bound (300)', () => {
    // complex base = 200; *1.3 = 260; still <= 300
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 5000, shadowRootCount: 20 });
    expect(t).toBeLessThanOrEqual(300);
    expect(t).toBe(260);
  });

  it('disabling shadow complexity scoring removes the overhead', () => {
    heuristicsEngine.featureFlags.enableShadowComplexityScoring = false;
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 1500, shadowRootCount: 12 });
    expect(t).toBe(150);
  });

  it('memory pressure >85% reduces timeout by ~50%', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.9);
    // complex base = 200; *0.5 = 100
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 5000 });
    expect(t).toBe(100);
  });

  it('memory pressure >70% (but <=85%) reduces timeout by ~25%', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.75);
    // complex base = 200; *0.75 = 150
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 5000 });
    expect(t).toBe(150);
  });

  it('memory pressure exactly 0.85 uses the >0.7 branch, not the >0.85 branch (strict >)', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.85);
    // complex base 200; 0.85 is not > 0.85 but is > 0.7 → *0.75 = 150
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 5000 });
    expect(t).toBe(150);
  });

  it('memory pressure exactly 0.70 triggers no reduction (strict >)', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.7);
    // complex base 200; 0.7 is not > 0.7 → unchanged
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 5000 });
    expect(t).toBe(200);
  });

  it('result never drops below the min bound (50) even under extreme pressure', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.99);
    // base 100 (simple) *0.5 = 50 → clamps at min
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 10 });
    expect(t).toBeGreaterThanOrEqual(50);
    expect(t).toBe(50);
  });

  it('result never exceeds the max bound (300)', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.5);
    const t = heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 100000, shadowRootCount: 50 });
    expect(t).toBeLessThanOrEqual(300);
  });

  it('returns base timeout when adaptive timeout disabled (ignores complexity)', () => {
    heuristicsEngine.featureFlags.enableAdaptiveTimeout = false;
    expect(heuristicsEngine.computeEnrichmentTimeout({ domNodeCount: 99999 })).toBe(100);
  });
});

describe('HeuristicsEngine.computeBatchConcurrency', () => {
  beforeEach(() => {
    heuristicsEngine.featureFlags.enableAdaptiveConcurrency = true;
    heuristicsEngine.featureFlags.enableMemoryPressureDetection = true;
    heuristicsEngine.clearCache();
    vi.spyOn(heuristicsEngine, 'estimateMemoryPressure').mockReturnValue(0.5);
  });

  it('returns base concurrency (15) for light pages', () => {
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 200 })).toBe(15);
  });

  it('reduces to 12 for medium complexity (>500 nodes)', () => {
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 1500 })).toBe(12);
  });

  it('reduces to 10 for complex pages (>2000 nodes)', () => {
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 5000 })).toBe(10);
  });

  it('reduces to 5 for very complex pages (>10000 nodes)', () => {
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 50000 })).toBe(5);
  });

  it('concurrency decreases monotonically as complexity grows', () => {
    const light = heuristicsEngine.computeBatchConcurrency({ domNodeCount: 100 });
    const medium = heuristicsEngine.computeBatchConcurrency({ domNodeCount: 1000 });
    const complex = heuristicsEngine.computeBatchConcurrency({ domNodeCount: 5000 });
    const veryComplex = heuristicsEngine.computeBatchConcurrency({ domNodeCount: 20000 });
    expect(light).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(complex);
    expect(complex).toBeGreaterThan(veryComplex);
  });

  it('memory pressure >90% reduces concurrency to ~1/3', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.95);
    // light base 15 → /3 = 5
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 200 })).toBe(5);
  });

  it('memory pressure >80% (but <=90%) reduces concurrency to ~1/2', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.85);
    // light base 15 → /2 = 7.5 → round 8
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 200 })).toBe(8);
  });

  it('memory pressure exactly 0.9 uses the >0.8 branch, not >0.9 (strict >)', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.9);
    // base 15; 0.9 not > 0.9 but > 0.8 → /2 = 7.5 → round 8
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 200 })).toBe(8);
  });

  it('memory pressure exactly 0.8 triggers no reduction (strict >)', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.8);
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 200 })).toBe(15);
  });

  it('result never drops below min bound (3) under critical pressure on already-low concurrency', () => {
    heuristicsEngine.estimateMemoryPressure.mockReturnValue(0.95);
    // veryComplex base 5 → /3 = 1.67 → round 2 → clamps to min 3
    const c = heuristicsEngine.computeBatchConcurrency({ domNodeCount: 50000 });
    expect(c).toBeGreaterThanOrEqual(3);
    expect(c).toBe(3);
  });

  it('result never exceeds max bound (20)', () => {
    const c = heuristicsEngine.computeBatchConcurrency({ domNodeCount: 10 });
    expect(c).toBeLessThanOrEqual(20);
  });

  it('returns base concurrency when adaptive concurrency disabled', () => {
    heuristicsEngine.featureFlags.enableAdaptiveConcurrency = false;
    expect(heuristicsEngine.computeBatchConcurrency({ domNodeCount: 99999 })).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// DIContainer register / resolve / lifecycle
//
// We construct fresh DIContainer instances (not the globalContainer) so the
// lazy bootstrap() that require()s real enrichment modules never fires — every
// service we resolve is one we registered, so the registry is non-empty and
// resolve() finds it without needing bootstrap's node-unfriendly require()s.
// ---------------------------------------------------------------------------
describe('DIContainer register + resolve', () => {
  let container;

  beforeEach(() => {
    container = new DIContainer();
    // Prevent the real lazy bootstrap from running (it require()s page-side
    // modules). Mark bootstrapped so resolve() never invokes it.
    container.bootstrapped = true;
  });

  it('singleton: resolve returns the SAME instance across calls', () => {
    const obj = { id: 'svc' };
    let calls = 0;
    container.register('thing', () => { calls++; return obj; }, true);

    const a = container.resolve('thing');
    const b = container.resolve('thing');
    expect(a).toBe(obj);
    expect(b).toBe(a);
    expect(calls).toBe(1); // factory invoked only once
  });

  it('transient: resolve returns a NEW instance each call', () => {
    let n = 0;
    container.register('counter', () => ({ n: n++ }), false);

    const a = container.resolve('counter');
    const b = container.resolve('counter');
    expect(a).not.toBe(b);
    expect(a.n).toBe(0);
    expect(b.n).toBe(1);
  });

  it('resolve throws for an unregistered service', () => {
    expect(() => container.resolve('nope')).toThrow(/Service not found: nope/);
  });

  it('error message for missing service lists the available services', () => {
    container.register('alpha', () => ({}), false);
    container.register('beta', () => ({}), false);
    expect(() => container.resolve('missing')).toThrow(/Available services: .*alpha.*beta/);
  });

  it('error message says "none" when no services registered', () => {
    expect(() => container.resolve('x')).toThrow(/Available services: none/);
  });

  it('re-registering an instantiated singleton throws with the service name', () => {
    container.register('singleton', () => ({}), true);
    container.resolve('singleton'); // instantiate → caches in instances map
    expect(() => container.register('singleton', () => ({}), true))
      .toThrow(/Cannot re-register singleton: singleton/);
  });

  it('re-registering a singleton that was never resolved is allowed', () => {
    container.register('lazy', () => ({ v: 1 }), true);
    // not resolved yet → instances map empty → re-register permitted
    expect(() => container.register('lazy', () => ({ v: 2 }), true)).not.toThrow();
    expect(container.resolve('lazy')).toEqual({ v: 2 });
  });

  it('has() reflects registration without instantiating', () => {
    expect(container.has('svc')).toBe(false);
    let made = false;
    container.register('svc', () => { made = true; return {}; }, true);
    expect(container.has('svc')).toBe(true);
    expect(made).toBe(false); // has() must not run the factory
  });

  it('unregister removes the factory and the cached singleton instance', () => {
    const inst = {};
    container.register('svc', () => inst, true);
    container.resolve('svc');
    container.unregister('svc');
    expect(container.has('svc')).toBe(false);
    expect(() => container.resolve('svc')).toThrow(/Service not found/);
  });

  it('clearService drops the cached instance but keeps the factory (re-instantiates)', () => {
    let count = 0;
    container.register('svc', () => ({ n: count++ }), true);
    const first = container.resolve('svc');
    container.clearService('svc');
    const second = container.resolve('svc');
    expect(container.has('svc')).toBe(true);
    expect(second).not.toBe(first);
    expect(second.n).toBe(1);
  });

  it('clear() drops all instances but preserves the registry', () => {
    container.register('a', () => ({}), true);
    container.register('b', () => ({}), true);
    const a1 = container.resolve('a');
    container.clear();
    expect(container.has('a')).toBe(true);
    expect(container.has('b')).toBe(true);
    const a2 = container.resolve('a');
    expect(a2).not.toBe(a1); // re-instantiated after clear
  });

  it('reset() empties registry and instances and re-arms bootstrap flag', () => {
    container.register('a', () => ({}), true);
    container.resolve('a');
    container.reset();
    expect(container.getServiceNames()).toEqual([]);
    expect(container.bootstrapped).toBe(false);
    expect(container.has('a')).toBe(false);
  });

  it('getServiceNames returns the registered names', () => {
    container.register('one', () => ({}), false);
    container.register('two', () => ({}), false);
    expect(container.getServiceNames().sort()).toEqual(['one', 'two']);
  });

  it('unregister of a non-existent service is a safe no-op', () => {
    expect(() => container.unregister('ghost')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ErrorTracker.logError deduplication + metrics
// ---------------------------------------------------------------------------
describe('ErrorTracker.logError + deduplication', () => {
  let tracker;

  beforeEach(() => {
    tracker = new ErrorTracker();
  });

  it('first error returns a TrackerError and increments totalErrors', () => {
    const err = tracker.logError(ERROR_CODES.ENRICHMENT_TIMEOUT, 'too slow', { elementId: 'e1' });
    expect(err).toBeInstanceOf(TrackerError);
    expect(err.code).toBe(ERROR_CODES.ENRICHMENT_TIMEOUT);
    expect(tracker.getMetrics().totalErrors).toBe(1);
  });

  it('duplicate within the dedupe window returns null and increments deduplicatedCount', () => {
    tracker.logError('code_a', 'same', { elementId: 'e1' });
    const dup = tracker.logError('code_a', 'same', { elementId: 'e1' });
    expect(dup).toBeNull();
    const m = tracker.getMetrics();
    expect(m.totalErrors).toBe(1);
    expect(m.deduplicatedCount).toBe(1);
  });

  it('different context (different elementId) is NOT deduplicated', () => {
    tracker.logError('code_a', 'msg', { elementId: 'e1' });
    const second = tracker.logError('code_a', 'msg', { elementId: 'e2' });
    expect(second).toBeInstanceOf(TrackerError);
    expect(tracker.getMetrics().totalErrors).toBe(2);
  });

  it('duplicate AFTER the dedupe window is logged as a new error', () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_000_000;
      vi.setSystemTime(t0);
      tracker.logError('code_a', 'msg', { elementId: 'e1' });

      // advance past DEDUPLICATION_WINDOW_MS (5000)
      vi.setSystemTime(t0 + ERROR_TRACKING_CONFIG.DEDUPLICATION_WINDOW_MS + 1);
      const again = tracker.logError('code_a', 'msg', { elementId: 'e1' });

      expect(again).toBeInstanceOf(TrackerError);
      expect(tracker.getMetrics().totalErrors).toBe(2);
      expect(tracker.getMetrics().deduplicatedCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('errorsByCode tracks per-code counts', () => {
    tracker.logError('code_a', 'm1', { elementId: 'a' });
    tracker.logError('code_a', 'm2', { elementId: 'b' });
    tracker.logError('code_b', 'm3', { elementId: 'c' });
    const byCode = tracker.getMetrics().errorsByCode;
    expect(byCode.code_a).toBe(2);
    expect(byCode.code_b).toBe(1);
  });

  it('errorsBySession tracks counts only when sessionId present', () => {
    tracker.logError('code_a', 'm1', { sessionId: 's1', elementId: 'a' });
    tracker.logError('code_a', 'm2', { sessionId: 's1', elementId: 'b' });
    tracker.logError('code_a', 'm3', { elementId: 'c' }); // no sessionId
    const bySession = tracker.getMetrics().errorsBySession;
    expect(bySession.s1).toBe(2);
    expect(Object.keys(bySession)).toEqual(['s1']);
  });

  it('context without sessionId still logs the error', () => {
    const err = tracker.logError('code_a', 'm', {});
    expect(err).toBeInstanceOf(TrackerError);
    expect(tracker.getMetrics().totalErrors).toBe(1);
  });

  it('errors array is capped at maxErrorHistory (shift oldest)', () => {
    tracker.maxErrorHistory = 3;
    for (let i = 0; i < 6; i++) {
      // Unique message keeps each error novel (avoids dedupe collapsing them).
      tracker.logError('code_a', `msg-${i}`, { elementId: `e${i}` });
    }
    // metrics.recentErrors reflects the bounded errors array
    const recent = tracker.getMetrics().recentErrors;
    expect(recent.length).toBe(3);
    expect(recent.map((e) => e.message)).toEqual(['msg-3', 'msg-4', 'msg-5']);
  });

  it('LRU evicts the lowest-count code when errorsByCode exceeds maxErrorsByCode', () => {
    tracker.maxErrorsByCode = 2;
    // code_a gets 2 hits, code_b gets 1, then code_c arrives → evicts lowest (code_b)
    tracker.logError('code_a', 'a1', { elementId: '1' });
    tracker.logError('code_a', 'a2', { elementId: '2' });
    tracker.logError('code_b', 'b1', { elementId: '3' });
    tracker.logError('code_c', 'c1', { elementId: '4' });
    const byCode = tracker.getMetrics().errorsByCode;
    expect(byCode.code_a).toBe(2);
    expect(byCode.code_c).toBe(1);
    expect(byCode.code_b).toBeUndefined(); // evicted (lowest count)
    expect(Object.keys(byCode).length).toBe(2);
  });

  it('LRU evicts the oldest session when errorsBySession exceeds maxErrorsBySession', () => {
    tracker.maxErrorsBySession = 2;
    tracker.logError('c', 'm1', { sessionId: 's1', elementId: '1' });
    tracker.logError('c', 'm2', { sessionId: 's2', elementId: '2' });
    tracker.logError('c', 'm3', { sessionId: 's3', elementId: '3' }); // evicts s1 (oldest)
    const bySession = tracker.getMetrics().errorsBySession;
    expect(bySession.s1).toBeUndefined();
    expect(bySession.s2).toBe(1);
    expect(bySession.s3).toBe(1);
  });

  it('hash generation is stable for identical code+message+context', () => {
    const h1 = tracker._generateErrorHash('code', 'msg', { elementId: 'e', sessionId: 's', url: 'u' });
    const h2 = tracker._generateErrorHash('code', 'msg', { elementId: 'e', sessionId: 's', url: 'u' });
    expect(h1).toBe(h2);
  });

  it('hash differs when a key context field changes', () => {
    const h1 = tracker._generateErrorHash('code', 'msg', { elementId: 'e1' });
    const h2 = tracker._generateErrorHash('code', 'msg', { elementId: 'e2' });
    expect(h1).not.toBe(h2);
  });

  it('getErrorsByCode returns defensive copies of matching errors', () => {
    tracker.logError('code_a', 'm1', { elementId: '1' });
    tracker.logError('code_b', 'm2', { elementId: '2' });
    const aErrors = tracker.getErrorsByCode('code_a');
    expect(aErrors.length).toBe(1);
    expect(aErrors[0].message).toBe('m1');
    aErrors[0].message = 'mutated';
    // original history untouched
    expect(tracker.getErrorsByCode('code_a')[0].message).toBe('m1');
  });

  it('getErrorsBySession filters by context.sessionId', () => {
    tracker.logError('c', 'm1', { sessionId: 's1', elementId: '1' });
    tracker.logError('c', 'm2', { sessionId: 's2', elementId: '2' });
    const s1 = tracker.getErrorsBySession('s1');
    expect(s1.length).toBe(1);
    expect(s1[0].message).toBe('m1');
  });

  it('clear() empties history and zeroes counts but preserves code keys', () => {
    tracker.logError('code_a', 'm1', { elementId: '1' });
    tracker.logError('code_b', 'm2', { elementId: '2' });
    tracker.clear();
    const m = tracker.getMetrics();
    expect(m.totalErrors).toBe(0);
    expect(m.deduplicatedCount).toBe(0);
    expect(m.recentErrors).toEqual([]);
    // code keys preserved with zeroed counts for consistent telemetry schema
    expect(m.errorsByCode).toEqual({ code_a: 0, code_b: 0 });
  });

  it('after clear(), a previously-deduped error can be logged again (dedupe cache cleared)', () => {
    tracker.logError('code_a', 'm', { elementId: '1' });
    tracker.clear();
    const err = tracker.logError('code_a', 'm', { elementId: '1' });
    expect(err).toBeInstanceOf(TrackerError);
    expect(tracker.getMetrics().totalErrors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TrackerError
// ---------------------------------------------------------------------------
describe('TrackerError', () => {
  it('sets code, message, context, timestamp and is an Error subclass', () => {
    const before = Date.now();
    const err = new TrackerError('my_code', 'boom', { foo: 'bar' });
    const after = Date.now();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TrackerError');
    expect(err.code).toBe('my_code');
    expect(err.message).toBe('boom');
    expect(err.context).toEqual({ foo: 'bar' });
    expect(err.timestamp).toBeGreaterThanOrEqual(before);
    expect(err.timestamp).toBeLessThanOrEqual(after);
  });

  it('defaults context to an empty object when omitted', () => {
    const err = new TrackerError('c', 'm');
    expect(err.context).toEqual({});
  });

  it('captures a stack trace', () => {
    const err = new TrackerError('c', 'm');
    expect(typeof err.stack).toBe('string');
    expect(err.stack.length).toBeGreaterThan(0);
  });

  it('toJSON serializes all fields including deeply nested context', () => {
    const ctx = { level1: { level2: { value: [1, 2, 3] } } };
    const err = new TrackerError('code', 'message', ctx);
    const json = err.toJSON();
    expect(json).toMatchObject({
      name: 'TrackerError',
      code: 'code',
      message: 'message',
      context: ctx,
    });
    expect(typeof json.timestamp).toBe('number');
    expect(typeof json.stack).toBe('string');
    // round-trips through JSON without throwing
    expect(() => JSON.stringify(json)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.context.level1.level2.value).toEqual([1, 2, 3]);
  });
});
