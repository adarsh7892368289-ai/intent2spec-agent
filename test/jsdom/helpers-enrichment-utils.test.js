// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  sanitizeMetadata,
  sanitizeEventData,
  getPageContext,
  clearPageContextCache,
  safeExecute,
} from '@core/helpers/enrichment-utils.js';
import { ENRICHMENT_CONFIG } from '@core/shared/config.js';

// ENRICHMENT_CONFIG is a const-bound object, but its *properties* are mutable.
// We snapshot/restore the props we touch so suites stay isolated.
const CONFIG_KEYS = [
  'MAX_CLASSES_PER_ELEMENT',
  'PARALLEL_TIMEOUT',
  'ENABLE_PAGE_CONTEXT_CACHE',
  'CACHE_EXPIRY_MS',
];

let configSnapshot;

beforeEach(() => {
  configSnapshot = {};
  for (const k of CONFIG_KEYS) configSnapshot[k] = ENRICHMENT_CONFIG[k];
  clearPageContextCache();
});

afterEach(() => {
  for (const k of CONFIG_KEYS) ENRICHMENT_CONFIG[k] = configSnapshot[k];
  clearPageContextCache();
});

describe('sanitizeMetadata', () => {
  it('returns {} for null / undefined metadata', () => {
    expect(sanitizeMetadata(null)).toEqual({});
    expect(sanitizeMetadata(undefined)).toEqual({});
  });

  it('preserves whitelisted essential fields', () => {
    const out = sanitizeMetadata({
      tag: 'input',
      id: 'email',
      type: 'email',
      name: 'user_email',
      role: 'textbox',
      width: 200,
      height: 30,
      placeholder: 'Enter email',
      title: 'Email field',
      alt: 'avatar',
      href: 'https://x.test',
      value: 'a@b.com',
      currentValue: 'typed',
      checked: true,
      required: true,
      disabled: false,
    });
    expect(out).toMatchObject({
      tag: 'input',
      id: 'email',
      type: 'email',
      name: 'user_email',
      role: 'textbox',
      width: 200,
      height: 30,
      placeholder: 'Enter email',
      title: 'Email field',
      alt: 'avatar',
      href: 'https://x.test',
      value: 'a@b.com',
      currentValue: 'typed',
      checked: true,
      required: true,
      disabled: false,
    });
  });

  it('drops non-whitelisted fields entirely', () => {
    const out = sanitizeMetadata({
      tag: 'div',
      innerHTML: '<script>x</script>',
      onclick: 'evil()',
      computedStyle: { color: 'red' },
      randomGarbage: 'nope',
    });
    expect(out).toEqual({ tag: 'div' });
    expect(out.innerHTML).toBeUndefined();
    expect(out.onclick).toBeUndefined();
    expect(out.computedStyle).toBeUndefined();
  });

  it('skips fields whose value is null or undefined', () => {
    const out = sanitizeMetadata({ tag: 'button', id: null, name: undefined, role: 'button' });
    expect(out).toEqual({ tag: 'button', role: 'button' });
    expect('id' in out).toBe(false);
    expect('name' in out).toBe(false);
  });

  it('preserves falsy-but-meaningful values (0, false, empty string)', () => {
    const out = sanitizeMetadata({ tag: 'input', width: 0, checked: false, value: '' });
    expect(out.width).toBe(0);
    expect(out.checked).toBe(false);
    expect(out.value).toBe('');
  });

  it('limits classes to MAX_CLASSES_PER_ELEMENT', () => {
    ENRICHMENT_CONFIG.MAX_CLASSES_PER_ELEMENT = 2;
    const out = sanitizeMetadata({ tag: 'div', classes: ['a', 'b', 'c', 'd'] });
    expect(out.classes).toEqual(['a', 'b']);
  });

  it('omits classes when array is empty', () => {
    const out = sanitizeMetadata({ tag: 'div', classes: [] });
    expect('classes' in out).toBe(false);
  });

  // ---- locator-critical preservation (the whole point of this helper) ----

  it('CRITICAL: preserves dataAttributes (needed for getByTestId)', () => {
    const out = sanitizeMetadata({
      tag: 'button',
      dataAttributes: {
        'data-testid': 'submit-btn',
        'data-qa': 'checkout',
        'data-cy': 'pay',
      },
    });
    expect(out.dataAttributes).toEqual({
      'data-testid': 'submit-btn',
      'data-qa': 'checkout',
      'data-cy': 'pay',
    });
  });

  it('CRITICAL: preserves ariaAttributes (needed for getByRole / getByLabel)', () => {
    const out = sanitizeMetadata({
      tag: 'button',
      ariaAttributes: {
        role: 'button',
        'aria-label': 'Close dialog',
        'aria-expanded': 'false',
      },
    });
    expect(out.ariaAttributes).toEqual({
      role: 'button',
      'aria-label': 'Close dialog',
      'aria-expanded': 'false',
    });
  });

  it('truncates data attribute values to 256 chars and stringifies them', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeMetadata({
      tag: 'div',
      dataAttributes: { 'data-blob': long, 'data-num': 42 },
    });
    expect(out.dataAttributes['data-blob']).toHaveLength(256);
    expect(out.dataAttributes['data-num']).toBe('42'); // String() coercion
  });

  it('truncates aria attribute values to 256 chars', () => {
    const long = 'y'.repeat(300);
    const out = sanitizeMetadata({ tag: 'div', ariaAttributes: { 'aria-label': long } });
    expect(out.ariaAttributes['aria-label']).toHaveLength(256);
  });

  it('drops null/undefined values inside dataAttributes/ariaAttributes but keeps the rest', () => {
    const out = sanitizeMetadata({
      tag: 'div',
      dataAttributes: { 'data-testid': 'keep', 'data-empty': null, 'data-undef': undefined },
      ariaAttributes: { role: 'tab', 'aria-x': null },
    });
    expect(out.dataAttributes).toEqual({ 'data-testid': 'keep' });
    expect(out.ariaAttributes).toEqual({ role: 'tab' });
  });

  it('omits dataAttributes/ariaAttributes entirely when all entries are nullish', () => {
    const out = sanitizeMetadata({
      tag: 'div',
      dataAttributes: { a: null, b: undefined },
      ariaAttributes: { c: null },
    });
    expect('dataAttributes' in out).toBe(false);
    expect('ariaAttributes' in out).toBe(false);
  });

  it('ignores dataAttributes/ariaAttributes when not objects', () => {
    expect(() =>
      sanitizeMetadata({ tag: 'div', dataAttributes: 'nope', ariaAttributes: 123 })
    ).not.toThrow();
    const out = sanitizeMetadata({ tag: 'div', dataAttributes: 'nope', ariaAttributes: 123 });
    expect('dataAttributes' in out).toBe(false);
    expect('ariaAttributes' in out).toBe(false);
  });

  it('preserves boolean false data values via String() coercion', () => {
    const out = sanitizeMetadata({ tag: 'div', dataAttributes: { 'data-active': false } });
    // false != null, so it is kept and stringified
    expect(out.dataAttributes['data-active']).toBe('false');
  });
});

describe('sanitizeEventData', () => {
  it('returns null for null / undefined input', () => {
    expect(sanitizeEventData(null)).toBeNull();
    expect(sanitizeEventData(undefined)).toBeNull();
  });

  it('keeps serializable scalar fields', () => {
    const out = sanitizeEventData({ key: 'Enter', count: 3, ok: true });
    expect(out).toEqual({ key: 'Enter', count: 3, ok: true });
  });

  it('drops blocklisted keys (target, currentTarget, srcElement, view, path, composedPath)', () => {
    const out = sanitizeEventData({
      key: 'a',
      target: { foo: 1 },
      currentTarget: { foo: 1 },
      srcElement: { foo: 1 },
      view: { foo: 1 },
      path: [1, 2],
      composedPath: [1, 2],
    });
    expect(out).toEqual({ key: 'a' });
  });

  it('drops DOM Node values', () => {
    const node = document.createElement('div');
    const out = sanitizeEventData({ key: 'x', node });
    expect(out).toEqual({ key: 'x' });
    expect('node' in out).toBe(false);
  });

  it('drops Window values', () => {
    const out = sanitizeEventData({ key: 'x', win: window });
    expect(out).toEqual({ key: 'x' });
  });

  it('drops function values', () => {
    const out = sanitizeEventData({ key: 'x', cb: () => {} });
    expect(out).toEqual({ key: 'x' });
  });

  it('skips fields that throw on JSON.stringify (circular reference)', () => {
    const circular = {};
    circular.self = circular;
    const out = sanitizeEventData({ key: 'x', circular });
    expect(out).toEqual({ key: 'x' });
    expect('circular' in out).toBe(false);
  });

  it('returns null when every field is blocklisted / unserializable', () => {
    const node = document.createElement('span');
    const out = sanitizeEventData({ target: {}, view: window, node, fn: () => {} });
    expect(out).toBeNull();
  });

  it('preserves nested serializable structures', () => {
    const out = sanitizeEventData({ detail: { a: [1, 2], b: { c: 'd' } } });
    expect(out).toEqual({ detail: { a: [1, 2], b: { c: 'd' } } });
  });
});

describe('safeExecute', () => {
  it('returns the synchronous result when fn completes', async () => {
    const result = await safeExecute(() => 42, 'fallback');
    expect(result).toBe(42);
  });

  it('returns the resolved value of an async fn', async () => {
    const result = await safeExecute(async () => 'async-ok', 'fallback');
    expect(result).toBe('async-ok');
  });

  it('returns fallback when fn throws synchronously', async () => {
    const result = await safeExecute(() => {
      throw new Error('boom');
    }, 'fb');
    expect(result).toBe('fb');
  });

  it('returns fallback when an async fn rejects', async () => {
    const result = await safeExecute(async () => {
      throw new Error('rejected');
    }, 'fb-async');
    expect(result).toBe('fb-async');
  });

  it('returns fallback when fn is null (calling null throws)', async () => {
    const result = await safeExecute(null, 'null-fb');
    expect(result).toBe('null-fb');
  });

  it('returns fallback when fn exceeds PARALLEL_TIMEOUT', async () => {
    ENRICHMENT_CONFIG.PARALLEL_TIMEOUT = 10;
    const slow = () => new Promise((resolve) => setTimeout(() => resolve('too-late'), 200));
    const result = await safeExecute(slow, 'timed-out');
    expect(result).toBe('timed-out');
  });

  it('returns the result when fn resolves before PARALLEL_TIMEOUT', async () => {
    ENRICHMENT_CONFIG.PARALLEL_TIMEOUT = 500;
    const quick = () => new Promise((resolve) => setTimeout(() => resolve('in-time'), 5));
    const result = await safeExecute(quick, 'fb');
    expect(result).toBe('in-time');
  });

  it('returns undefined-fallback when configured so (fallback is honoured verbatim)', async () => {
    const result = await safeExecute(() => {
      throw new Error('x');
    }, undefined);
    expect(result).toBeUndefined();
  });
});

describe('getPageContext / clearPageContextCache', () => {
  beforeEach(() => {
    // Stable starting URL/title for deterministic assertions.
    history.replaceState(null, '', '/page-a');
    document.title = 'Title A';
  });

  it('returns a context with url, pageTitle, and timestamp when cache disabled', async () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = false;
    const ctx = getPageContext();
    expect(ctx).toMatchObject({
      url: window.location.href,
      pageTitle: 'Title A',
    });
    expect(typeof ctx.timestamp).toBe('number');
  });

  it('falls back to "Untitled Page" when document.title is empty', () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = false;
    document.title = '';
    const ctx = getPageContext();
    expect(ctx.pageTitle).toBe('Untitled Page');
  });

  it('returns a Promise on cache-miss when caching enabled, resolving to the context', async () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = true;
    const result = getPageContext();
    expect(typeof result.then).toBe('function');
    const ctx = await result;
    expect(ctx).toMatchObject({ url: window.location.href, pageTitle: 'Title A' });
  });

  it('deduplicates concurrent in-flight calls to the same promise', () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = true;
    const p1 = getPageContext();
    const p2 = getPageContext();
    // Second synchronous caller gets the same in-flight promise, not a new one.
    expect(p1).toBe(p2);
  });

  it('returns the cached object synchronously once populated and still valid', async () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = true;
    ENRICHMENT_CONFIG.CACHE_EXPIRY_MS = 60000;
    const ctx = await getPageContext(); // populate cache
    const cached = getPageContext(); // fast path: synchronous object, same ref
    expect(cached).toBe(ctx);
    expect(typeof cached.then).toBe('undefined');
  });

  it('invalidates cache when the URL changes', async () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = true;
    ENRICHMENT_CONFIG.CACHE_EXPIRY_MS = 60000;
    const ctxA = await getPageContext();
    expect(ctxA.url).toContain('/page-a');

    history.replaceState(null, '', '/page-b');
    document.title = 'Title B';
    const ctxB = await getPageContext(); // URL changed → cache miss → new context
    expect(ctxB.url).toContain('/page-b');
    expect(ctxB.pageTitle).toBe('Title B');
    expect(ctxB).not.toBe(ctxA);
  });

  it('re-creates context after cache expiry (TTL)', async () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = true;
    ENRICHMENT_CONFIG.CACHE_EXPIRY_MS = 60000;
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000_000);
    const ctx1 = await getPageContext();

    // Advance virtual time past TTL.
    nowSpy.mockReturnValue(1_000_000 + 60000 + 1);
    const ctx2 = await getPageContext();
    expect(ctx2).not.toBe(ctx1);
    nowSpy.mockRestore();
  });

  it('clearPageContextCache forces a fresh context creation', async () => {
    ENRICHMENT_CONFIG.ENABLE_PAGE_CONTEXT_CACHE = true;
    ENRICHMENT_CONFIG.CACHE_EXPIRY_MS = 60000;
    const ctx1 = await getPageContext();
    clearPageContextCache();
    const ctx2 = await getPageContext();
    expect(ctx2).not.toBe(ctx1);
    expect(clearPageContextCache()).toBeUndefined();
  });
});
