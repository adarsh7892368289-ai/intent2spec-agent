import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  generateElementId,
  generateSessionId,
  generateUniqueId,
  getTimestamp,
  isEmpty,
} from '@core/shared/utils.js';

import {
  safeExecute,
  safeExecuteWithRetry,
  getCircuitBreakerStates,
  resetCircuitBreakers,
} from '@core/shared/safe-execute.js';

import { errorTracker } from '@core/shared/error-tracking.js';
import {
  CIRCUIT_BREAKER_CONFIG,
  RETRY_CONFIG,
} from '@core/shared/config.js';

// ---------------------------------------------------------------------------
// utils.js — id generation, timestamps, emptiness
// ---------------------------------------------------------------------------

describe('utils.js / generateElementId', () => {
  it('uses the elem_ prefix and embeds a base36 timestamp + 5-char suffix', () => {
    const id = generateElementId();
    expect(id).toMatch(/^elem_\d+_[a-z0-9]{1,5}$/);
    const [, ts] = id.split('_');
    expect(Number(ts)).toBeGreaterThan(0);
  });

  it('embeds the current timestamp (within a small clock skew)', () => {
    const before = Date.now();
    const id = generateElementId();
    const after = Date.now();
    const ts = Number(id.split('_')[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('produces no duplicates across 100 calls (collision-resistant)', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(generateElementId());
    expect(ids.size).toBe(100);
  });

  it('is chronologically sortable: a later timestamp sorts after an earlier one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const older = generateElementId();
    vi.setSystemTime(2_000_000);
    const newer = generateElementId();
    vi.useRealTimers();

    const tsOld = Number(older.split('_')[1]);
    const tsNew = Number(newer.split('_')[1]);
    expect(tsNew).toBeGreaterThan(tsOld);
    // String comparison also orders them (fixed-width-ish numeric prefix).
    expect(older < newer).toBe(true);
  });

  it('produces a suffix no longer than 5 chars (substring(2,7))', () => {
    // Force Math.random to its largest representable value so the base36
    // fractional expansion is as long as possible.
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999999999999999);
    const id = generateElementId();
    spy.mockRestore();
    const suffix = id.split('_')[2];
    expect(suffix.length).toBeLessThanOrEqual(5);
    expect(suffix).toMatch(/^[a-z0-9]+$/);
  });
});

describe('utils.js / generateSessionId', () => {
  it('uses the session_ prefix and a longer (<=7-char) suffix', () => {
    const id = generateSessionId();
    expect(id).toMatch(/^session_\d+_[a-z0-9]{1,7}$/);
  });

  it('generates unique ids across multiple calls', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(50);
  });

  it('allows a longer suffix than generateElementId (substring 2..9 vs 2..7)', () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999999999999999);
    const sessionSuffix = generateSessionId().split('_')[2];
    const elemSuffix = generateElementId().split('_')[2];
    spy.mockRestore();
    // session takes 7 random chars max, element takes 5 max.
    expect(sessionSuffix.length).toBeGreaterThanOrEqual(elemSuffix.length);
    expect(sessionSuffix.length).toBeLessThanOrEqual(7);
  });
});

describe('utils.js / generateUniqueId', () => {
  it('defaults to the cor_ prefix', () => {
    expect(generateUniqueId()).toMatch(/^cor_\d+_[a-z0-9]{1,7}$/);
  });

  it('honours a custom prefix', () => {
    expect(generateUniqueId('widget')).toMatch(/^widget_\d+_[a-z0-9]{1,7}$/);
  });

  it('handles an empty-string prefix (leading underscore)', () => {
    const id = generateUniqueId('');
    expect(id).toMatch(/^_\d+_[a-z0-9]{1,7}$/);
  });

  it('passes special characters in the prefix through verbatim', () => {
    const id = generateUniqueId('a.b:c/d');
    expect(id.startsWith('a.b:c/d_')).toBe(true);
  });
});

describe('utils.js / getTimestamp', () => {
  it('returns an ISO-8601 UTC string ending in Z', () => {
    expect(getTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('is parseable by Date (not NaN)', () => {
    expect(Number.isNaN(Date.parse(getTimestamp()))).toBe(false);
  });

  it('reflects the system clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-05T10:20:30.456Z'));
    expect(getTimestamp()).toBe('2025-01-05T10:20:30.456Z');
    vi.useRealTimers();
  });

  it('subsequent calls return non-decreasing timestamps', () => {
    const a = getTimestamp();
    const b = getTimestamp();
    expect(b >= a).toBe(true);
  });
});

describe('utils.js / isEmpty', () => {
  it.each([
    ['null', null, true],
    ['undefined', undefined, true],
    ['empty array', [], true],
    ['empty object', {}, true],
    ['empty string', '', true],
    ['spaces only', '   ', true],
    ['tabs/newlines only', '\t\n\r ', true],
    ['non-empty array', [1], false],
    ['non-empty object', { a: 1 }, false],
    ['non-empty string', 'x', false],
    ['number zero', 0, false],
    ['boolean false', false, false],
    ['number 1', 1, false],
    ['boolean true', true, false],
  ])('isEmpty(%s) === %s', (_label, value, expected) => {
    expect(isEmpty(value)).toBe(expected);
  });

  it('treats a nested object that has keys as non-empty even if the nested value is empty', () => {
    expect(isEmpty({ inner: {} })).toBe(false);
  });

  it('does NOT treat zero/false as empty (regression guard)', () => {
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safe-execute.js — safeExecute
// ---------------------------------------------------------------------------

describe('safe-execute.js / safeExecute', () => {
  let logSpy;

  beforeEach(() => {
    resetCircuitBreakers();
    logSpy = vi.spyOn(errorTracker, 'logError').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCircuitBreakers();
  });

  it('returns the result when the function completes before the timeout', async () => {
    const result = await safeExecute(async () => 'ok', 'fallback', {
      timeout: 100,
      operationName: 'se_success',
    });
    expect(result).toBe('ok');
  });

  it('records a success on the operation circuit breaker', async () => {
    await safeExecute(async () => 42, null, { operationName: 'se_cb_success' });
    // Closed + zero failures after a clean run.
    const state = getCircuitBreakerStates().se_cb_success;
    expect(state.state).toBe('closed');
    expect(state.failureCount).toBe(0);
  });

  it('returns the fallback and logs the error when the function throws synchronously', async () => {
    const result = await safeExecute(
      () => {
        throw new Error('boom');
      },
      'fb',
      { operationName: 'se_sync_throw' },
    );
    expect(result).toBe('fb');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [, msg] = logSpy.mock.calls[0];
    expect(msg).toContain('boom');
  });

  it('records a failure on the circuit breaker when the function rejects', async () => {
    await safeExecute(
      async () => {
        throw new Error('nope');
      },
      'fb',
      { operationName: 'se_cb_fail' },
    );
    expect(getCircuitBreakerStates().se_cb_fail.failureCount).toBe(1);
  });

  it('respects the silent flag: no error is logged', async () => {
    const result = await safeExecute(
      async () => {
        throw new Error('quiet');
      },
      'fb',
      { operationName: 'se_silent', silent: true },
    );
    expect(result).toBe('fb');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns the fallback when a never-resolving function exceeds the timeout', async () => {
    vi.useFakeTimers();
    const promise = safeExecute(() => new Promise(() => {}), 'timed-out', {
      timeout: 50,
      operationName: 'se_timeout',
    });
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;
    expect(result).toBe('timed-out');
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][1]).toMatch(/Timeout after 50ms/);
  });

  it('a slow function that exceeds the timeout still records a circuit-breaker failure', async () => {
    vi.useFakeTimers();
    const promise = safeExecute(() => new Promise(() => {}), null, {
      timeout: 25,
      operationName: 'se_timeout_cb',
    });
    await vi.advanceTimersByTimeAsync(25);
    await promise;
    expect(getCircuitBreakerStates().se_timeout_cb.failureCount).toBe(1);
  });

  it('short-circuits to the fallback once the breaker for the operation is OPEN', async () => {
    // Drive the breaker open with FAILURE_THRESHOLD failing calls.
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await safeExecute(
        () => {
          throw new Error('fail');
        },
        'fb',
        { operationName: 'se_open', silent: true },
      );
    }
    expect(getCircuitBreakerStates().se_open.state).toBe('open');

    // Next call should not even invoke the function — it returns fallback fast.
    const fn = vi.fn(async () => 'should-not-run');
    const result = await safeExecute(fn, 'fb-open', { operationName: 'se_open' });
    expect(result).toBe('fb-open');
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// safe-execute.js — safeExecuteWithRetry
// ---------------------------------------------------------------------------

describe('safe-execute.js / safeExecuteWithRetry', () => {
  let logSpy;

  beforeEach(() => {
    resetCircuitBreakers();
    logSpy = vi.spyOn(errorTracker, 'logError').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCircuitBreakers();
  });

  it('returns the result on the first attempt without retrying', async () => {
    const fn = vi.fn(async () => 'first');
    const result = await safeExecuteWithRetry(fn, 'fb', {
      operationName: 'retry_first',
    });
    expect(result).toBe('first');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient error then succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('network glitch');
      return 'recovered';
    });

    const promise = safeExecuteWithRetry(fn, 'fb', {
      operationName: 'retry_transient',
      initialDelay: 50,
      jitterFactor: 0,
    });
    // Flush the backoff sleep between attempt 1 and 2.
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fails fast on a permanent (non-transient) error without retrying', async () => {
    const fn = vi.fn(async () => {
      throw new Error('validation failed: bad input');
    });
    const result = await safeExecuteWithRetry(fn, 'fb', {
      operationName: 'retry_permanent',
    });
    expect(result).toBe('fb');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][1]).toMatch(/Permanent error/);
  });

  it('returns fallback and logs after exhausting maxRetries on persistent transient errors', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new Error('connection timeout');
    });
    const promise = safeExecuteWithRetry(fn, 'fb-exhausted', {
      operationName: 'retry_exhaust',
      maxRetries: 3,
      initialDelay: 10,
      jitterFactor: 0,
      backoffMultiplier: 2,
    });
    // 2 backoff sleeps between 3 attempts: 10ms then 20ms.
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    const result = await promise;

    expect(result).toBe('fb-exhausted');
    expect(fn).toHaveBeenCalledTimes(3);
    // Final failure log mentions the retry count.
    expect(logSpy.mock.calls.at(-1)[1]).toMatch(/Failed after 3 retries/);
  });

  it('maxRetries=1 means a single attempt with no retry sleep', async () => {
    const fn = vi.fn(async () => {
      throw new Error('timeout occurred');
    });
    const result = await safeExecuteWithRetry(fn, 'fb', {
      operationName: 'retry_one',
      maxRetries: 1,
    });
    expect(result).toBe('fb');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff (delay grows by backoffMultiplier) with jitterFactor=0', async () => {
    vi.useFakeTimers();
    const delays = [];
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const fn = vi.fn(async () => {
      throw new Error('temporarily unavailable');
    });
    const promise = safeExecuteWithRetry(fn, 'fb', {
      operationName: 'retry_backoff',
      maxRetries: 4,
      initialDelay: 100,
      maxDelay: 5000,
      backoffMultiplier: 2,
      jitterFactor: 0,
    });
    // Advance generously to drain all scheduled sleeps.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await promise;

    for (const call of setTimeoutSpy.mock.calls) {
      if (typeof call[1] === 'number' && call[1] > 0) delays.push(call[1]);
    }
    // With jitter disabled, the three backoff sleeps are 100, 200, 400.
    expect(delays).toEqual([100, 200, 400]);
    setTimeoutSpy.mockRestore();
  });

  it('caps the backoff delay at maxDelay', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const fn = vi.fn(async () => {
      throw new Error('rate limit hit');
    });
    const promise = safeExecuteWithRetry(fn, 'fb', {
      operationName: 'retry_cap',
      maxRetries: 4,
      initialDelay: 1000,
      maxDelay: 1500,
      backoffMultiplier: 10,
      jitterFactor: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    await promise;

    const scheduled = setTimeoutSpy.mock.calls
      .map((c) => c[1])
      .filter((d) => typeof d === 'number' && d > 0);
    for (const d of scheduled) expect(d).toBeLessThanOrEqual(1500);
    setTimeoutSpy.mockRestore();
  });

  it('uses RETRY_CONFIG defaults when no overrides are supplied', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await safeExecuteWithRetry(fn, 'fb', {
      operationName: 'retry_defaults',
    });
    expect(result).toBe('ok');
    // Sanity: defaults are what we think they are (drives the no-override path).
    expect(RETRY_CONFIG.MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// safe-execute.js — CircuitBreaker state machine (exercised via the registry)
// ---------------------------------------------------------------------------

describe('safe-execute.js / CircuitBreaker state transitions', () => {
  beforeEach(() => {
    resetCircuitBreakers();
    vi.spyOn(errorTracker, 'logError').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCircuitBreakers();
  });

  const failOnce = (op) =>
    safeExecute(
      () => {
        throw new Error('x');
      },
      null,
      { operationName: op, silent: true },
    );

  const succeedOnce = (op) =>
    safeExecute(async () => 'ok', null, { operationName: op, silent: true });

  it('starts CLOSED and allows execution', async () => {
    await succeedOnce('cb_start');
    expect(getCircuitBreakerStates().cb_start.state).toBe('closed');
  });

  it('opens after FAILURE_THRESHOLD consecutive failures', async () => {
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await failOnce('cb_open');
    }
    const state = getCircuitBreakerStates().cb_open;
    expect(state.state).toBe('open');
    expect(state.failureCount).toBe(CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD);
  });

  it('stays CLOSED below the failure threshold', async () => {
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD - 1; i++) {
      await failOnce('cb_below');
    }
    expect(getCircuitBreakerStates().cb_below.state).toBe('closed');
  });

  it('a single success while CLOSED does not change state and resets failureCount', async () => {
    await failOnce('cb_reset');
    expect(getCircuitBreakerStates().cb_reset.failureCount).toBe(1);
    await succeedOnce('cb_reset');
    const state = getCircuitBreakerStates().cb_reset;
    expect(state.state).toBe('closed');
    expect(state.failureCount).toBe(0);
  });

  it('transitions OPEN -> HALF_OPEN after the timeout window, allowing one probe through', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Open the breaker.
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await failOnce('cb_halfopen');
    }
    expect(getCircuitBreakerStates().cb_halfopen.state).toBe('open');

    // Advance the system clock past the open timeout window. canExecute() reads
    // Date.now() directly, so move the clock rather than relying on timers.
    vi.setSystemTime(CIRCUIT_BREAKER_CONFIG.TIMEOUT_MS + 1);

    // A probe call should be allowed through (breaker enters HALF_OPEN).
    // One probe success is not enough to close (SUCCESS_THRESHOLD is 2), so the
    // breaker should remain half_open afterwards — proving the transition was real.
    const probe = vi.fn(async () => 'probe');
    const result = await safeExecute(probe, 'fb', {
      operationName: 'cb_halfopen',
      silent: true,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result).toBe('probe');
    expect(CIRCUIT_BREAKER_CONFIG.SUCCESS_THRESHOLD).toBeGreaterThan(1);
    expect(getCircuitBreakerStates().cb_halfopen.state).toBe('half_open');
    expect(getCircuitBreakerStates().cb_halfopen.successCount).toBe(1);
  });

  it('closes from HALF_OPEN after SUCCESS_THRESHOLD successes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await failOnce('cb_close');
    }
    vi.setSystemTime(CIRCUIT_BREAKER_CONFIG.TIMEOUT_MS + 1);

    // First success moves into half-open (canExecute flips state) and counts 1.
    // Need SUCCESS_THRESHOLD successes total in half-open to close.
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.SUCCESS_THRESHOLD; i++) {
      await succeedOnce('cb_close');
    }
    const state = getCircuitBreakerStates().cb_close;
    expect(state.state).toBe('closed');
    expect(state.failureCount).toBe(0);
  });

  it('in HALF_OPEN, repeated failures consume the half-open probe budget and re-block calls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    // Open the breaker.
    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await failOnce('cb_budget');
    }
    vi.setSystemTime(CIRCUIT_BREAKER_CONFIG.TIMEOUT_MS + 1);

    // The OPEN->HALF_OPEN transition probe is "free" (canExecute resets
    // halfOpenCalls=0 and returns true without incrementing). After that, each
    // half-open probe increments halfOpenCalls up to HALF_OPEN_MAX_CALLS. Failing
    // probes never close the breaker, so the total number of allowed probes
    // before re-blocking is HALF_OPEN_MAX_CALLS + 1 (the free transition + budget).
    const max = CIRCUIT_BREAKER_CONFIG.HALF_OPEN_MAX_CALLS;
    let allowed = 0;
    for (let i = 0; i < max + 1; i++) {
      const fn = vi.fn(() => {
        throw new Error('still broken');
      });
      await safeExecute(fn, 'fb', { operationName: 'cb_budget', silent: true });
      if (fn.mock.calls.length > 0) allowed++;
    }
    expect(allowed).toBe(max + 1);
    expect(getCircuitBreakerStates().cb_budget.state).toBe('half_open');

    // Budget exhausted: the next probe must be blocked (function not invoked).
    const blocked = vi.fn(async () => 'ran');
    const result = await safeExecute(blocked, 'fb-blocked', {
      operationName: 'cb_budget',
      silent: true,
    });
    expect(blocked).not.toHaveBeenCalled();
    expect(result).toBe('fb-blocked');
  });

  it('once OPEN, blocks calls until the timeout elapses (function not invoked)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    for (let i = 0; i < CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD; i++) {
      await failOnce('cb_blocked');
    }
    expect(getCircuitBreakerStates().cb_blocked.state).toBe('open');

    // Still within the timeout window -> blocked.
    vi.setSystemTime(CIRCUIT_BREAKER_CONFIG.TIMEOUT_MS - 1);
    const fn = vi.fn(async () => 'ran');
    const result = await safeExecute(fn, 'fb-blocked', {
      operationName: 'cb_blocked',
      silent: true,
    });
    expect(fn).not.toHaveBeenCalled();
    expect(result).toBe('fb-blocked');
  });

  it('getCircuitBreakerStates exposes a per-operation snapshot; resetCircuitBreakers clears them', async () => {
    await failOnce('cb_snapshot');
    expect(getCircuitBreakerStates()).toHaveProperty('cb_snapshot');
    expect(getCircuitBreakerStates().cb_snapshot).toMatchObject({
      name: 'cb_snapshot',
      state: 'closed',
    });
    resetCircuitBreakers();
    expect(getCircuitBreakerStates()).toEqual({});
  });
});
