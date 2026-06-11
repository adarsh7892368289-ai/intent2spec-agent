import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// page-session.js does `require('playwright')` at module load and reaches for a
// real browser launcher. Stub the module so the file loads in a node test env
// without a browser binary. The PageSession unit surface under test (constructor
// defaults, _withTimeout, getTrackerBundleSource) never actually launches.
vi.mock('playwright', () => {
  const fakeLauncher = (name) => ({ launch: vi.fn(async () => ({ __browser: name })) });
  return {
    chromium: fakeLauncher('chromium'),
    firefox: fakeLauncher('firefox'),
    webkit: fakeLauncher('webkit'),
  };
});

// page-session.js is CJS and reads the bundle via `require('fs').readFileSync`.
// In this Vitest setup, `vi.mock('fs')` only intercepts ESM imports — a bare
// `require('fs')` still resolves to the real singleton module. So to control
// readFileSync we spy on the REAL fs object (the same instance the module's
// `require('fs')` captured), which the source's reference observes.
import realFs from 'node:fs';

import { PageSession, getTrackerBundleSource } from '../../src/mcp/page-session.js';

describe('PageSession constructor', () => {
  it('defaults browserType to chromium and headless to true with no options', () => {
    const s = new PageSession();
    expect(s.browserType).toBe('chromium');
    expect(s.headless).toBe(true);
  });

  it('defaults are applied when called with an empty object', () => {
    const s = new PageSession({});
    expect(s.browserType).toBe('chromium');
    expect(s.headless).toBe(true);
  });

  it('honors a provided browserType (firefox)', () => {
    expect(new PageSession({ browserType: 'firefox' }).browserType).toBe('firefox');
  });

  it('honors a provided browserType (webkit) while keeping default headless', () => {
    const s = new PageSession({ browserType: 'webkit' });
    expect(s.browserType).toBe('webkit');
    expect(s.headless).toBe(true);
  });

  it('honors headless: false while keeping default browserType', () => {
    const s = new PageSession({ headless: false });
    expect(s.headless).toBe(false);
    expect(s.browserType).toBe('chromium');
  });

  it('initializes browser, context, and page to null', () => {
    const s = new PageSession();
    expect(s.browser).toBeNull();
    expect(s.context).toBeNull();
    expect(s.page).toBeNull();
  });

  it('initializes inventoryCache as an empty Map', () => {
    const s = new PageSession();
    expect(s.inventoryCache).toBeInstanceOf(Map);
    expect(s.inventoryCache.size).toBe(0);
  });

  it('initializes lastScanKey to null', () => {
    expect(new PageSession().lastScanKey).toBeNull();
  });

  it('treats headless as a literal, not a truthiness coercion (false stays false)', () => {
    // Guards against a `headless = headless || true` style default that would
    // wrongly flip an explicit false back to true.
    expect(new PageSession({ headless: false }).headless).toBe(false);
  });
});

describe('PageSession#_withTimeout', () => {
  let session;

  beforeEach(() => {
    session = new PageSession();
  });

  it('resolves with the underlying value when the promise settles before the timeout', async () => {
    const result = await session._withTimeout(Promise.resolve('fast'), 1000, 'op');
    expect(result).toBe('fast');
  });

  it('resolves an already-resolved promise immediately', async () => {
    await expect(session._withTimeout(Promise.resolve(42), 50, 'op')).resolves.toBe(42);
  });

  it('propagates the original rejection when the promise rejects before the timeout', async () => {
    const boom = new Error('inner failure');
    await expect(session._withTimeout(Promise.reject(boom), 1000, 'op')).rejects.toBe(boom);
  });

  it('rejects with a timeout error mentioning the label when the promise stays pending', async () => {
    const pending = new Promise(() => {}); // never settles
    await expect(session._withTimeout(pending, 5, 'page scan')).rejects.toThrow(
      /page scan timed out after/
    );
  });

  it('rounds the timeout to whole seconds in the message (45000ms -> 45s)', async () => {
    const pending = new Promise(() => {});
    // Use fake timers so we do not actually wait 45s.
    vi.useFakeTimers();
    try {
      const p = session._withTimeout(pending, 45_000, 'page scan');
      const assertion = expect(p).rejects.toThrow('page scan timed out after 45s');
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timeout after the promise settles early (no dangling timer)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await session._withTimeout(Promise.resolve('ok'), 1000, 'op');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('calls timer.unref() when available so the timer does not keep the process alive', async () => {
    const unref = vi.fn();
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
      // Return a fake timer handle exposing unref; never fire the callback.
      void fn;
      void ms;
      return { unref };
    });
    try {
      await session._withTimeout(Promise.resolve('done'), 1000, 'op');
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setSpy.mockRestore();
    }
  });

  it('does not throw when the timer handle has no unref (e.g. browser-style numeric handle)', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 123);
    try {
      await expect(session._withTimeout(Promise.resolve('v'), 1000, 'op')).resolves.toBe('v');
    } finally {
      setSpy.mockRestore();
    }
  });

  it('honors a very short timeout against a slow promise (timeout wins the race)', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 200));
    await expect(session._withTimeout(slow, 1, 'page scan')).rejects.toThrow(/timed out/);
  });
});

describe('getTrackerBundleSource', () => {
  // The module caches the bundle source in a module-scoped `_bundleSource`. To
  // exercise the "file absent" path deterministically (a real
  // dist/tracker-bundle.js exists on disk in this repo), reset the module
  // registry per test so each fresh import starts with an empty cache, and spy
  // on the real fs.readFileSync to control what each candidate path returns.
  let readSpy;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    readSpy?.mockRestore();
    readSpy = undefined;
  });

  async function loadFreshWith(readFileSyncImpl) {
    readSpy = vi.spyOn(realFs, 'readFileSync').mockImplementation(readFileSyncImpl);
    const mod = await import('../../src/mcp/page-session.js');
    return mod;
  }

  it('throws a clear, actionable error when no candidate bundle file exists', async () => {
    const mod = await loadFreshWith(() => {
      const e = new Error('ENOENT: no such file or directory');
      e.code = 'ENOENT';
      throw e;
    });
    expect(() => mod.getTrackerBundleSource()).toThrow(
      'tracker-bundle.js not found — run: npm run build:bundle'
    );
  });

  it('returns file contents when the first candidate is readable', async () => {
    const readFileSync = vi.fn(() => 'BUNDLE_SOURCE_CONTENT');
    const mod = await loadFreshWith(readFileSync);
    expect(mod.getTrackerBundleSource()).toBe('BUNDLE_SOURCE_CONTENT');
  });

  it('caches the result: a second call does not re-read from disk', async () => {
    const readFileSync = vi.fn(() => 'CACHED_BUNDLE');
    const mod = await loadFreshWith(readFileSync);
    const first = mod.getTrackerBundleSource();
    const callsAfterFirst = readFileSync.mock.calls.length;
    const second = mod.getTrackerBundleSource();
    expect(second).toBe(first);
    expect(readFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  it('falls back to the second candidate when the first read throws (permission/ENOENT)', async () => {
    let call = 0;
    const readFileSync = vi.fn(() => {
      call += 1;
      if (call === 1) {
        const e = new Error('EACCES: permission denied');
        e.code = 'EACCES';
        throw e;
      }
      return 'SECOND_CANDIDATE_BUNDLE';
    });
    const mod = await loadFreshWith(readFileSync);
    expect(mod.getTrackerBundleSource()).toBe('SECOND_CANDIDATE_BUNDLE');
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});
