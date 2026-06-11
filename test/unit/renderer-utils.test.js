import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { relativeTime, absoluteCalendarDate } from '../../src/renderer/utils/time.js';
import {
  hostFromUrl,
  lastPathSegment,
  envTag,
  STAGE_RE,
} from '../../src/renderer/utils/report-metadata.js';
import {
  sanitizeErrorMessage,
  sanitizeFilename,
} from '../../src/renderer/utils/sanitize.js';
import {
  NOTIFICATION_DURATION_INDEFINITE,
  NOTIFICATION_DURATION_LONG_MS,
  NOTIFICATION_DURATION_SHORT_MS,
} from '../../src/renderer/constants/notification-timing.js';

// notification-queue.js keeps module-level singleton state (_visible, _waitQueue,
// _spamStamps, etc.). To keep each test hermetic we re-import the module fresh via
// vi.resetModules() + dynamic import, so the singleton starts clean every time.
const QUEUE_PATH = '../../src/renderer/application/notification-queue.js';

// Node environment (no DOM). time.js is mocked deterministically with fake timers.

// ---------------------------------------------------------------------------
// time.js
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  // Pin "now" to a fixed instant so the relative math is fully deterministic.
  // 2025-06-15 12:00:00 local — mid-year so same-year branch is exercised.
  const NOW = new Date(2025, 5, 15, 12, 0, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const minutesAgo = (m) => NOW.getTime() - m * 60_000;

  it('returns "just now" for under a minute ago', () => {
    expect(relativeTime(minutesAgo(0))).toBe('just now');
    expect(relativeTime(NOW.getTime() - 59_000)).toBe('just now');
  });

  it('returns "Xm ago" for minutes under an hour', () => {
    expect(relativeTime(minutesAgo(1))).toBe('1m ago');
    expect(relativeTime(minutesAgo(30))).toBe('30m ago');
    expect(relativeTime(minutesAgo(59))).toBe('59m ago');
  });

  it('rounds down at the exact 60-minute boundary to 1h ago', () => {
    // Exactly 60 mins ago -> mins===60 is no longer < 60, so it becomes hours.
    expect(relativeTime(minutesAgo(60))).toBe('1h ago');
    // 59m59s ago still floors to 59 minutes.
    expect(relativeTime(NOW.getTime() - (59 * 60_000 + 59_000))).toBe('59m ago');
  });

  it('returns "Xh ago" for hours under a day', () => {
    expect(relativeTime(minutesAgo(60 * 2))).toBe('2h ago');
    expect(relativeTime(minutesAgo(60 * 23))).toBe('23h ago');
  });

  it('returns "Xd ago" for days under a week', () => {
    expect(relativeTime(minutesAgo(60 * 24))).toBe('1d ago');
    expect(relativeTime(minutesAgo(60 * 24 * 6))).toBe('6d ago');
  });

  it('returns "Mon D" for >= 7 days ago in the same year', () => {
    // 8 days before 2025-06-15 is 2025-06-07.
    const eightDaysAgo = new Date(2025, 5, 7, 12, 0, 0, 0).getTime();
    expect(relativeTime(eightDaysAgo)).toBe('Jun 7');
  });

  it('returns "Mon D, YYYY" for a date in a different year', () => {
    const lastYear = new Date(2024, 0, 5, 12, 0, 0, 0).getTime();
    expect(relativeTime(lastYear)).toBe('Jan 5, 2024');
  });

  it('returns "" for falsy / empty timestamps', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(undefined)).toBe('');
    expect(relativeTime('')).toBe('');
    expect(relativeTime(0)).toBe('');
  });

  it('returns "" for an invalid timestamp (NaN date)', () => {
    expect(relativeTime('not-a-date')).toBe('');
    expect(relativeTime(NaN)).toBe('');
  });

  it('accepts ISO string timestamps, not just epoch numbers', () => {
    const iso = new Date(minutesAgo(5)).toISOString();
    expect(relativeTime(iso)).toBe('5m ago');
  });
});

describe('absoluteCalendarDate', () => {
  it('formats a timestamp as "Month D, YYYY"', () => {
    const ts = new Date(2025, 0, 5, 9, 30, 0, 0).getTime();
    expect(absoluteCalendarDate(ts)).toBe('January 5, 2025');
  });

  it('returns "" for falsy timestamps', () => {
    expect(absoluteCalendarDate(null)).toBe('');
    expect(absoluteCalendarDate(undefined)).toBe('');
    expect(absoluteCalendarDate('')).toBe('');
    // 0 is falsy and short-circuits before the Date parse.
    expect(absoluteCalendarDate(0)).toBe('');
  });

  it('returns "" for an invalid timestamp', () => {
    expect(absoluteCalendarDate('garbage')).toBe('');
    expect(absoluteCalendarDate(NaN)).toBe('');
  });

  it('formats the unix epoch when given as an ISO string (non-falsy)', () => {
    // 0 is falsy so it short-circuits; pass the epoch as an explicit instant instead.
    const epoch = new Date(Date.UTC(1970, 0, 1, 12, 0, 0)).getTime();
    expect(absoluteCalendarDate(epoch)).toMatch(/^January 1, 1970$/);
  });
});

// ---------------------------------------------------------------------------
// report-metadata.js
// ---------------------------------------------------------------------------

describe('hostFromUrl', () => {
  it('extracts the hostname from a valid URL', () => {
    expect(hostFromUrl('https://example.com/path')).toBe('example.com');
  });

  it('strips the port and keeps deep subdomains', () => {
    expect(hostFromUrl('http://sub.example.co.uk:8080/')).toBe('sub.example.co.uk');
  });

  it('falls back to the input string for an unparseable URL', () => {
    expect(hostFromUrl('not-a-url')).toBe('not-a-url');
  });

  it('returns "" for null/empty', () => {
    expect(hostFromUrl(null)).toBe('');
    expect(hostFromUrl('')).toBe('');
    expect(hostFromUrl(undefined)).toBe('');
  });

  it('coerces non-string input to a string before parsing', () => {
    // String(123) is "123", not a valid URL -> falls back to "123".
    expect(hostFromUrl(123)).toBe('123');
  });

  it('lowercases the host (URL API normalizes)', () => {
    expect(hostFromUrl('https://EXAMPLE.COM/Path')).toBe('example.com');
  });
});

describe('lastPathSegment', () => {
  it('returns the last segment prefixed with "/"', () => {
    expect(lastPathSegment('https://example.com/users/123')).toBe('/123');
  });

  it('returns "/" for a root path with a trailing slash', () => {
    expect(lastPathSegment('https://example.com/')).toBe('/');
  });

  it('returns "/" for a URL with no path', () => {
    expect(lastPathSegment('https://example.com')).toBe('/');
  });

  it('strips a trailing slash before extracting', () => {
    expect(lastPathSegment('https://example.com/users/123/')).toBe('/123');
  });

  it('returns "" for null/empty', () => {
    expect(lastPathSegment(null)).toBe('');
    expect(lastPathSegment('')).toBe('');
    expect(lastPathSegment(undefined)).toBe('');
  });

  it('returns "" for an unparseable URL', () => {
    expect(lastPathSegment('not a url')).toBe('');
  });
});

describe('envTag', () => {
  it('tags staging/dev/test-like hosts as STAGE', () => {
    expect(envTag('https://staging.example.com')).toBe('STAGE');
    expect(envTag('https://dev.example.com')).toBe('STAGE');
    expect(envTag('https://qa.example.com')).toBe('STAGE');
    expect(envTag('https://uat.example.com')).toBe('STAGE');
    expect(envTag('https://sandbox.example.com')).toBe('STAGE');
  });

  it('tags ordinary hosts as PROD', () => {
    expect(envTag('https://example.com')).toBe('PROD');
    expect(envTag('https://production.example.com')).toBe('PROD');
  });

  it('returns null for falsy input', () => {
    expect(envTag(null)).toBeNull();
    expect(envTag('')).toBeNull();
    expect(envTag(undefined)).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(envTag('https://STAGING.example.com')).toBe('STAGE');
  });

  it('requires a whole-word stage token (substring does not match)', () => {
    // STAGE_RE uses \b boundaries; "devil" contains "dev" but not as a word.
    expect(envTag('https://devil.example.com')).toBe('PROD');
    expect(envTag('https://thequalifier.example.com')).toBe('PROD');
  });

  it('STAGE_RE is exported and matches expected tokens', () => {
    expect(STAGE_RE.test('preview')).toBe(true);
    expect(STAGE_RE.test('canary')).toBe(true);
    expect(STAGE_RE.test('production')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitize.js (pure parts only)
// ---------------------------------------------------------------------------

describe('sanitizeErrorMessage', () => {
  it('returns "Unknown error" for null/undefined', () => {
    expect(sanitizeErrorMessage(null)).toBe('Unknown error');
    expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
  });

  it('extracts the message property from an Error-like object', () => {
    expect(sanitizeErrorMessage(new Error('boom'))).toBe('boom');
    expect(sanitizeErrorMessage({ message: 'plain message' })).toBe('plain message');
  });

  it('returns a short single-line string unchanged', () => {
    expect(sanitizeErrorMessage('Error text')).toBe('Error text');
  });

  it('returns only the first line of a multi-line message', () => {
    expect(sanitizeErrorMessage('line1\nline2\nline3')).toBe('line1');
  });

  it('truncates at "Browser logs:"', () => {
    expect(sanitizeErrorMessage('real error Browser logs: noise here')).toBe('real error');
  });

  it('truncates at "Call log:"', () => {
    expect(sanitizeErrorMessage('real error Call log: noise here')).toBe('real error');
  });

  it('uses the earliest marker when both "Browser logs:" and "Call log:" appear', () => {
    // 'Browser logs:' is sliced first; then 'Call log:' index becomes -1, no-op.
    expect(
      sanitizeErrorMessage('msg Browser logs: a Call log: b'),
    ).toBe('msg');
  });

  it('handles "Call log:" appearing before "Browser logs:"', () => {
    // Browser-logs slice runs first; here it is absent, so Call-log slice applies.
    expect(sanitizeErrorMessage('msg Call log: details')).toBe('msg');
  });

  it('truncates a >200-char first line and appends an ellipsis', () => {
    const long = 'x'.repeat(250);
    const out = sanitizeErrorMessage(long);
    expect(out).toHaveLength(201); // 200 chars + the … character (length 1)
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, 200)).toBe('x'.repeat(200));
  });

  it('returns "Unknown error" when the first line is empty after stripping', () => {
    expect(sanitizeErrorMessage('Browser logs: only logs')).toBe('Unknown error');
    expect(sanitizeErrorMessage('')).toBe('Unknown error');
    expect(sanitizeErrorMessage('   ')).toBe('Unknown error');
  });

  it('coerces non-string, non-message values via String()', () => {
    expect(sanitizeErrorMessage(404)).toBe('404');
  });
});

describe('sanitizeFilename', () => {
  it('passes a clean filename through unchanged', () => {
    expect(sanitizeFilename('report.json')).toBe('report.json');
    expect(sanitizeFilename('my-file_123.json')).toBe('my-file_123.json');
  });

  it('replaces runs of invalid characters with a single dash', () => {
    // '@' and '!' -> '-' giving 'report-2025-.json', then the '-.' run (both in
    // the [-_.] class) collapses to a single '-', yielding 'report-2025-json'.
    expect(sanitizeFilename('report@2025!.json')).toBe('report-2025-json');
  });

  it('defaults to "export" for null/undefined', () => {
    expect(sanitizeFilename(null)).toBe('export');
    expect(sanitizeFilename(undefined)).toBe('export');
  });

  it('collapses consecutive dashes/underscores/dots to a single dash', () => {
    expect(sanitizeFilename('a----b')).toBe('a-b');
    expect(sanitizeFilename('a___b')).toBe('a-b');
    expect(sanitizeFilename('a...b')).toBe('a-b');
  });

  it('strips leading and trailing separators', () => {
    expect(sanitizeFilename('---report---')).toBe('report');
    expect(sanitizeFilename('__.report._')).toBe('report');
  });

  it('falls back to "export" when nothing survives cleanup', () => {
    expect(sanitizeFilename('----')).toBe('export');
    expect(sanitizeFilename('@@@@')).toBe('export');
    expect(sanitizeFilename('')).toBe('export');
  });

  it('truncates to 200 characters', () => {
    const out = sanitizeFilename('a'.repeat(500));
    expect(out).toHaveLength(200);
  });

  it('strips path separators (no traversal in the filename)', () => {
    // Both / and \ are outside [a-zA-Z0-9_.-] so they become dashes.
    const out = sanitizeFilename('../../etc/passwd');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
    expect(out).not.toContain('..');
  });

  it('removes null bytes', () => {
    expect(sanitizeFilename('file name.txt')).toBe('file-name.txt');
  });
});


// ---------------------------------------------------------------------------
// notification-queue.js
// ---------------------------------------------------------------------------
//
// normalizeDuration is NOT exported; its behavior is asserted indirectly via
// dispatchEnqueue -> buildItem -> normalizeDuration. The resulting item is observable
// through the mounted handler (item.durationMs).
//
// The module keeps singleton state, so each test re-imports it fresh via
// vi.resetModules() + dynamic import to stay hermetic.

function makeHandlers() {
  const calls = { mounted: [], updated: [], dismissed: [], removed: [] };
  const handlers = {
    mountNotification(item) {
      calls.mounted.push(item);
      return { __id: item.id };
    },
    updateNotificationContent(id, item) {
      calls.updated.push({ id, item });
    },
    beginDismissToast(el) {
      calls.dismissed.push(el);
    },
    removeToastElement(el) {
      calls.removed.push(el);
    },
  };
  return { handlers, calls };
}

async function freshQueue() {
  vi.resetModules();
  const mod = await import(QUEUE_PATH);
  const { handlers, calls } = makeHandlers();
  mod.initNotificationQueue(handlers);
  return { mod, handlers, calls };
}

describe('notification-queue: dispatchEnqueue', () => {
  let mod;
  let calls;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ mod, calls } = await freshQueue());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // Advance just past the 800ms spam window (but well under the 4000ms info
  // auto-dismiss) so sequential enqueues are not detected as a coalescing burst.
  function pastSpamWindow() {
    vi.advanceTimersByTime(801);
  }

  it('mounts immediately when fewer than 3 toasts are visible', () => {
    const id = mod.dispatchEnqueue({ tier: 'info', title: 'hello' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(calls.mounted).toHaveLength(1);
    expect(calls.mounted[0].title).toBe('hello');
    expect(mod.getNotificationState()).toBe(mod.NotificationState.ACTIVE);
  });

  it('returns a unique id per enqueue', () => {
    const a = mod.dispatchEnqueue({ tier: 'info', title: 'a' });
    const b = mod.dispatchEnqueue({ tier: 'info', title: 'b' });
    expect(a).not.toBe(b);
  });

  it('honors an explicitly provided id', () => {
    const id = mod.dispatchEnqueue({ tier: 'info', title: 'x', id: 'fixed-id' });
    expect(id).toBe('fixed-id');
    expect(calls.mounted[0].id).toBe('fixed-id');
  });

  it('defaults tier to "info", title to "", source to "renderer"', () => {
    mod.dispatchEnqueue({});
    const item = calls.mounted[0];
    expect(item.tier).toBe('info');
    expect(item.title).toBe('');
    expect(item.source).toBe('renderer');
    expect(item.repeatCount).toBe(1);
    expect(item.body).toBeNull();
  });

  it('mounts up to 3 toasts, then evicts the oldest on the 4th', () => {
    // Space enqueues past the 800ms spam window so coalescing never trips
    // (under fake timers Date.now() is frozen; without spacing the 3rd enqueue
    // would be detected as a burst and buffered instead of mounted).
    mod.dispatchEnqueue({ tier: 'info', title: '1' });
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'info', title: '2' });
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'info', title: '3' });
    expect(calls.mounted).toHaveLength(3);
    expect(calls.dismissed).toHaveLength(0);
    pastSpamWindow();
    // 4th: visible is full, so the oldest is asked to dismiss (not mounted yet).
    mod.dispatchEnqueue({ tier: 'info', title: '4' });
    expect(calls.mounted).toHaveLength(3);
    expect(calls.dismissed).toHaveLength(1);
    expect(calls.dismissed[0].__id).toBe(calls.mounted[0].id);
  });

  it('merges a duplicate dedupeKey already in the wait queue', () => {
    // Use indefinite (error) toasts so nothing auto-dismisses, and space them so
    // the burst detector never fires; this leaves a stable 3-visible state.
    mod.dispatchEnqueue({ tier: 'error', title: 'a' });
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'error', title: 'b' });
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'error', title: 'c' });
    pastSpamWindow();
    // 4th: visible full -> evict oldest and enqueue this one into the wait queue.
    const first = mod.dispatchEnqueue({ tier: 'error', title: 'dup-1', dedupeKey: 'K' });
    const mountedBefore = calls.mounted.length;
    pastSpamWindow();
    // Same dedupeKey while 'dup-1' is still waiting -> merge, no new mount.
    const second = mod.dispatchEnqueue({ tier: 'error', title: 'dup-2', dedupeKey: 'K' });
    expect(second).not.toBe(first);
    expect(calls.mounted.length).toBe(mountedBefore);
  });

  it('updates content in place for a duplicate dedupeKey that is currently visible', () => {
    mod.dispatchEnqueue({ tier: 'info', title: 'visible', dedupeKey: 'VIS' });
    expect(calls.mounted).toHaveLength(1);
    mod.dispatchEnqueue({ tier: 'info', title: 'visible-updated', dedupeKey: 'VIS' });
    expect(calls.mounted).toHaveLength(1);
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].item.title).toBe('visible-updated');
  });

  it('never merges items without a dedupeKey', () => {
    mod.dispatchEnqueue({ tier: 'info', title: 'x' });
    mod.dispatchEnqueue({ tier: 'info', title: 'y' });
    expect(calls.mounted).toHaveLength(2);
    expect(calls.updated).toHaveLength(0);
  });

  it('coalesces a burst of 3+ enqueues within the spam window into the buffer', () => {
    // No spacing: three enqueues at the frozen instant trip the burst detector on
    // the 3rd (G_spam >= 3 stamps within 800ms).
    mod.dispatchEnqueue({ tier: 'info', title: '1' });
    mod.dispatchEnqueue({ tier: 'info', title: '2' });
    // 3rd within window -> coalescing: item buffered (not mounted), state COALESCING.
    mod.dispatchEnqueue({ tier: 'info', title: '3' });
    expect(mod.getNotificationState()).toBe(mod.NotificationState.COALESCING);
    expect(calls.mounted).toHaveLength(2);
    // Advance by 0ms to fire ONLY the 0ms coalesce timer (not the 4000ms
    // auto-dismiss timers), draining the buffer into the visible set.
    vi.advanceTimersByTime(0);
    expect(mod.getNotificationState()).toBe(mod.NotificationState.ACTIVE);
    expect(calls.mounted).toHaveLength(3);
  });

  it('schedules an auto-dismiss timer for finite-duration toasts', () => {
    mod.dispatchEnqueue({ tier: 'info', title: 'auto', durationMs: 1000 });
    expect(calls.dismissed).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(calls.dismissed).toHaveLength(1);
  });

  it('does NOT schedule auto-dismiss for indefinite (error) toasts', () => {
    mod.dispatchEnqueue({ tier: 'error', title: 'sticky' });
    vi.advanceTimersByTime(60_000);
    expect(calls.dismissed).toHaveLength(0);
  });

  it('prioritizes an error-tier toast to the front of the wait queue', () => {
    // Errors are indefinite (no auto-dismiss). Space enqueues to avoid coalescing.
    mod.dispatchEnqueue({ tier: 'error', title: 'e1' });
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'error', title: 'e2' });
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'error', title: 'e3' }); // 3 visible (all indefinite)
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'info', title: 'queued-info' }); // evict oldest, queued
    pastSpamWindow();
    mod.dispatchEnqueue({ tier: 'error', title: 'queued-error' }); // unshift to front
    // Complete removal of the evicted oldest toast, which pumps the wait queue.
    const oldestEl = calls.dismissed[0];
    mod.dispatchRemoveAnimationComplete(oldestEl);
    const lastMountedTitle = calls.mounted[calls.mounted.length - 1].title;
    expect(lastMountedTitle).toBe('queued-error');
  });
});

describe('notification-queue: normalizeDuration (via item.durationMs)', () => {
  let mod;
  let calls;

  beforeEach(async () => {
    vi.useFakeTimers();
    ({ mod, calls } = await freshQueue());
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const lastDuration = () => calls.mounted[calls.mounted.length - 1].durationMs;

  it('info tier with no duration -> SHORT', () => {
    mod.dispatchEnqueue({ tier: 'info', title: 'i' });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_SHORT_MS);
  });

  it('warning tier with no duration -> LONG', () => {
    mod.dispatchEnqueue({ tier: 'warning', title: 'w' });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_LONG_MS);
  });

  it('error tier with no duration -> INDEFINITE', () => {
    mod.dispatchEnqueue({ tier: 'error', title: 'e' });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_INDEFINITE);
  });

  it('duration === 0 is treated as INDEFINITE regardless of tier', () => {
    mod.dispatchEnqueue({ tier: 'info', title: 'z', durationMs: 0 });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_INDEFINITE);
  });

  it('duration === INDEFINITE stays INDEFINITE', () => {
    mod.dispatchEnqueue({ tier: 'info', title: 'n', durationMs: NOTIFICATION_DURATION_INDEFINITE });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_INDEFINITE);
  });

  it('"inherit" defers to tier defaults', () => {
    mod.dispatchEnqueue({ tier: 'warning', title: 'inh', durationMs: 'inherit' });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_LONG_MS);
  });

  it('a positive numeric duration is returned verbatim', () => {
    mod.dispatchEnqueue({ tier: 'info', title: 'num', durationMs: 7000 });
    expect(lastDuration()).toBe(7000);
  });

  it('a negative duration is rejected and falls back to the tier default', () => {
    // Space the three enqueues past the 800ms spam window so each is actually
    // mounted (otherwise the 3rd would be coalesced and never reach mountNotification).
    mod.dispatchEnqueue({ tier: 'info', title: 'neg', durationMs: -500 });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_SHORT_MS);
    vi.advanceTimersByTime(801);
    mod.dispatchEnqueue({ tier: 'warning', title: 'neg2', durationMs: -500 });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_LONG_MS);
    vi.advanceTimersByTime(801);
    mod.dispatchEnqueue({ tier: 'error', title: 'neg3', durationMs: -500 });
    expect(lastDuration()).toBe(NOTIFICATION_DURATION_INDEFINITE);
  });
});
