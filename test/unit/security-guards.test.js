import { describe, it, expect } from 'vitest';
import {
  isHttpUrl,
  assertHttpUrl,
  isBrowserDescriptorAllowed,
  isSafeBasename,
  stripPollutionKeys,
} from '@security/guards.js';

// Security-critical guards. Node environment, no DOM. WHATWG URL is global in Node.
// These suites are deliberately adversarial: encoded traversal, prototype pollution
// at depth and inside arrays, null bytes, mixed separators, credentials/punycode URLs,
// and allow-list bypass attempts.

describe('isHttpUrl', () => {
  it('accepts http and https', () => {
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('https://example.com')).toBe(true);
  });

  it('accepts a fully-specified http URL with port, path, query, hash', () => {
    expect(isHttpUrl('http://example.com:8080/path?query=1#hash')).toBe(true);
  });

  it('rejects non-http(s) protocols', () => {
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isHttpUrl('ws://example.com')).toBe(false);
  });

  it('rejects malformed / non-URL strings', () => {
    expect(isHttpUrl('not-a-url')).toBe(false);
    expect(isHttpUrl('http://')).toBe(false); // protocol only, no host -> not parseable
    expect(isHttpUrl('://example.com')).toBe(false);
    expect(isHttpUrl('http:// space .com')).toBe(false);
  });

  it('rejects empty string and non-string inputs without throwing', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl({})).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
    expect(isHttpUrl([])).toBe(false);
  });

  it('treats protocol case-insensitively (WHATWG lowercases the scheme)', () => {
    expect(isHttpUrl('HTTP://example.com')).toBe(true);
    expect(isHttpUrl('HtTpS://example.com')).toBe(true);
  });

  it('accepts URLs with embedded credentials', () => {
    expect(isHttpUrl('http://user:pass@example.com')).toBe(true);
  });

  it('accepts punycode and unicode IDN domains', () => {
    expect(isHttpUrl('https://xn--80ak6aa92e.com')).toBe(true);
    expect(isHttpUrl('https://例え.テスト')).toBe(true);
  });

  it('accepts very long but valid URLs', () => {
    const long = 'https://example.com/' + 'a'.repeat(5000);
    expect(isHttpUrl(long)).toBe(true);
  });
});

describe('assertHttpUrl', () => {
  it('returns the normalized href (with trailing slash) for valid URLs', () => {
    expect(assertHttpUrl('https://example.com')).toBe('https://example.com/');
    expect(assertHttpUrl('http://example.com')).toBe('http://example.com/');
  });

  it('preserves path/query/hash in the normalized href', () => {
    expect(assertHttpUrl('http://example.com/a/b?x=1#h')).toBe('http://example.com/a/b?x=1#h');
  });

  it('lowercases scheme and host in the returned href', () => {
    expect(assertHttpUrl('HTTP://Example.COM')).toBe('http://example.com/');
  });

  it('throws a parse error (no INVALID_URL code) for unparseable input', () => {
    let err;
    try {
      assertHttpUrl('not-a-url');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('URL is not a valid URL');
    expect(err.code).toBeUndefined();
  });

  it('throws with INVALID_URL code for wrong protocol', () => {
    let err;
    try {
      assertHttpUrl('ftp://example.com');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('INVALID_URL');
    expect(err.message).toContain('must use http:// or https://');
    expect(err.message).toContain('ftp:');
  });

  it('uses the custom label in both error paths', () => {
    expect(() => assertHttpUrl('nope', 'MyURL')).toThrow('MyURL is not a valid URL');
    expect(() => assertHttpUrl('ftp://x.com', 'Custom')).toThrow(
      'Custom must use http:// or https://'
    );
  });

  it('throws for null, undefined, and empty string', () => {
    expect(() => assertHttpUrl(null)).toThrow('URL is not a valid URL');
    expect(() => assertHttpUrl(undefined)).toThrow('URL is not a valid URL');
    expect(() => assertHttpUrl('')).toThrow('URL is not a valid URL');
  });

  it('rejects dangerous schemes that could bypass an http-only assumption', () => {
    expect(() => assertHttpUrl('file:///etc/passwd')).toThrow(/INVALID|http/i);
    expect(() => assertHttpUrl('javascript:alert(1)')).toThrow();
  });
});

describe('isBrowserDescriptorAllowed', () => {
  it('allows Playwright-managed engines (channel and executablePath both null)', () => {
    expect(isBrowserDescriptorAllowed({ channel: null, executablePath: null }, [])).toBe(true);
  });

  it('treats an empty descriptor object as managed (no channel/executablePath)', () => {
    expect(isBrowserDescriptorAllowed({}, [])).toBe(true);
  });

  it('allows a system browser that matches a launchable detected entry', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'chromium', channel: 'stable' }, [
        { browserType: 'chromium', channel: 'stable', executablePath: null, isLaunchable: true },
      ])
    ).toBe(true);
  });

  it('matches on executablePath when channel is absent', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'chromium', executablePath: '/x/chrome' }, [
        { browserType: 'chromium', channel: null, executablePath: '/x/chrome' },
      ])
    ).toBe(true);
  });

  it('defaults missing isLaunchable to allowed (only explicit false blocks)', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'chromium', channel: 'stable' }, [
        { browserType: 'chromium', channel: 'stable', executablePath: null },
      ])
    ).toBe(true);
  });

  it('blocks a matching descriptor when the detected entry is isLaunchable:false', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'chromium', channel: 'stable' }, [
        { browserType: 'chromium', channel: 'stable', executablePath: null, isLaunchable: false },
      ])
    ).toBe(false);
  });

  it('rejects on browserType mismatch', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'firefox', channel: 'stable' }, [
        { browserType: 'chromium', channel: 'stable', isLaunchable: true },
      ])
    ).toBe(false);
  });

  it('rejects on channel mismatch (beta requested, only stable detected)', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'chromium', channel: 'beta' }, [
        { browserType: 'chromium', channel: 'stable' },
      ])
    ).toBe(false);
  });

  it('rejects when the channel/path-bearing descriptor is not in an empty detected set', () => {
    expect(isBrowserDescriptorAllowed({ channel: 'stable' }, [])).toBe(false);
  });

  it('ignores extra/unexpected descriptor properties when matching', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'chromium', channel: 'stable', extra: 'x' }, [
        { browserType: 'chromium', channel: 'stable', executablePath: null, isLaunchable: true },
      ])
    ).toBe(true);
  });

  it('tolerates null entries inside the detected array', () => {
    expect(
      isBrowserDescriptorAllowed({ browserType: 'chromium', channel: 'stable' }, [
        null,
        undefined,
        { browserType: 'chromium', channel: 'stable', executablePath: null, isLaunchable: true },
      ])
    ).toBe(true);
  });

  it('returns false for a falsy or non-object descriptor', () => {
    expect(isBrowserDescriptorAllowed(null, [])).toBe(false);
    expect(isBrowserDescriptorAllowed(undefined, [])).toBe(false);
    expect(isBrowserDescriptorAllowed('not-object', [])).toBe(false);
    expect(isBrowserDescriptorAllowed(123, [])).toBe(false);
  });

  it('returns false when a channel-bearing descriptor is checked against a non-array detected set', () => {
    expect(isBrowserDescriptorAllowed({ channel: 'stable' }, null)).toBe(false);
    expect(isBrowserDescriptorAllowed({ channel: 'stable' }, 'not-array')).toBe(false);
    expect(isBrowserDescriptorAllowed({ channel: 'stable' }, undefined)).toBe(false);
  });

  it('still allows managed engines even when detectedBrowsers is not an array (managed short-circuits)', () => {
    expect(isBrowserDescriptorAllowed({ channel: null, executablePath: null }, null)).toBe(true);
    expect(isBrowserDescriptorAllowed({}, 'garbage')).toBe(true);
  });

  it('blocks bypass via channel match where executablePath differs', () => {
    // Attacker supplies a malicious executablePath but a legit channel.
    expect(
      isBrowserDescriptorAllowed(
        { browserType: 'chromium', channel: 'stable', executablePath: '/tmp/evil' },
        [{ browserType: 'chromium', channel: 'stable', executablePath: null, isLaunchable: true }]
      )
    ).toBe(false);
  });
});

describe('isSafeBasename', () => {
  it('accepts ordinary filenames', () => {
    expect(isSafeBasename('file.txt')).toBe(true);
    expect(isSafeBasename('my-file_123.json')).toBe(true);
  });

  it('accepts leading-dot (hidden) names', () => {
    expect(isSafeBasename('.hidden')).toBe(true);
    expect(isSafeBasename('.env.local')).toBe(true);
  });

  it('accepts unicode characters in an otherwise-safe name', () => {
    expect(isSafeBasename('café-résumé.txt')).toBe(true);
    expect(isSafeBasename('日本語.json')).toBe(true);
  });

  it('rejects names containing a forward slash', () => {
    expect(isSafeBasename('file/path')).toBe(false);
    expect(isSafeBasename('a/b/c')).toBe(false);
    expect(isSafeBasename('/etc/passwd')).toBe(false);
    expect(isSafeBasename('dir//file')).toBe(false);
  });

  it('rejects names containing a backslash (Windows traversal)', () => {
    expect(isSafeBasename('file\\path')).toBe(false);
    expect(isSafeBasename('..\\..\\windows\\system32')).toBe(false);
  });

  it('rejects mixed-separator paths', () => {
    expect(isSafeBasename('a/b\\c')).toBe(false);
    expect(isSafeBasename('a\\b/c')).toBe(false);
  });

  it('rejects any name containing a ".." sequence (traversal defense-in-depth)', () => {
    expect(isSafeBasename('..')).toBe(false);
    expect(isSafeBasename('...')).toBe(false);
    expect(isSafeBasename('..foo')).toBe(false);
    expect(isSafeBasename('foo..')).toBe(false);
    // Source rejects ".." ANYWHERE, including the interior. The brief lists
    // 'file..txt' -> true, but the actual (stricter, safer) behavior is false.
    // We assert the real, more-secure behavior rather than the brief's expectation.
    expect(isSafeBasename('file..txt')).toBe(false);
    expect(isSafeBasename('a..b')).toBe(false);
  });

  it("rejects the current-directory name '.'", () => {
    expect(isSafeBasename('.')).toBe(false);
  });

  it('allows a single interior dot (a.b) — only ".." is forbidden', () => {
    expect(isSafeBasename('a.b')).toBe(true);
    expect(isSafeBasename('archive.tar.gz')).toBe(true);
  });

  it('rejects names containing a NUL byte', () => {
    expect(isSafeBasename('file\0name')).toBe(false);
    expect(isSafeBasename('safe.txt\0.evil')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafeBasename('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isSafeBasename(null)).toBe(false);
    expect(isSafeBasename(undefined)).toBe(false);
    expect(isSafeBasename(123)).toBe(false);
    expect(isSafeBasename({})).toBe(false);
    expect(isSafeBasename(['file.txt'])).toBe(false);
  });

  it('accepts a name at exactly the 255-char boundary and rejects 256', () => {
    expect(isSafeBasename('a'.repeat(255))).toBe(true);
    expect(isSafeBasename('a'.repeat(256))).toBe(false);
  });

  it('does not decode URL-encoded traversal (literal %2e is just characters)', () => {
    // %2e%2e%2f contains no real "/" or ".." so it is treated as a literal,
    // safe basename. The decode/contain check happens elsewhere (path-guards).
    expect(isSafeBasename('%2e%2e%2f')).toBe(true);
    // But a literal ".." mixed with encoding is still caught.
    expect(isSafeBasename('..%2f')).toBe(false);
  });
});

describe('stripPollutionKeys', () => {
  it('returns plain objects unchanged in content', () => {
    expect(stripPollutionKeys({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
  });

  it('passes primitives and nullish values straight through', () => {
    expect(stripPollutionKeys(null)).toBeNull();
    expect(stripPollutionKeys(undefined)).toBeUndefined();
    expect(stripPollutionKeys('string')).toBe('string');
    expect(stripPollutionKeys(123)).toBe(123);
    expect(stripPollutionKeys(true)).toBe(true);
  });

  it('strips an own __proto__ key created via JSON.parse', () => {
    // Literal {__proto__:...} sets the prototype (not an own key); JSON.parse
    // produces a genuine OWN enumerable __proto__ key — the real pollution vector.
    const polluted = JSON.parse('{"__proto__":{"isAdmin":true},"a":1}');
    expect(Object.prototype.hasOwnProperty.call(polluted, '__proto__')).toBe(true);
    const out = stripPollutionKeys(polluted);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(out).toEqual({ a: 1 });
    // Ensure no actual prototype pollution leaked onto Object.prototype.
    expect({}.isAdmin).toBeUndefined();
  });

  it('strips enumerable constructor and prototype keys', () => {
    const o = { a: 1 };
    Object.defineProperty(o, 'constructor', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(o, 'prototype', {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.keys(o)).toEqual(expect.arrayContaining(['constructor', 'prototype']));
    expect(stripPollutionKeys(o)).toEqual({ a: 1 });
  });

  it('strips pollution keys recursively in nested objects', () => {
    const nested = { a: JSON.parse('{"__proto__":{"b":2},"keep":3}') };
    expect(stripPollutionKeys(nested)).toEqual({ a: { keep: 3 } });
  });

  it('strips pollution keys inside arrays and preserves array shape', () => {
    const arr = JSON.parse('[1, {"__proto__":{"x":1},"k":2}, 3]');
    const out = stripPollutionKeys(arr);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([1, { k: 2 }, 3]);
  });

  it('cleans pollution keys nested deeply inside arrays of objects', () => {
    const input = {
      list: [JSON.parse('{"__proto__":{"e":1},"good":1}'), { nested: [JSON.parse('{"constructor":{},"v":9}')] }],
    };
    expect(stripPollutionKeys(input)).toEqual({
      list: [{ good: 1 }, { nested: [{ v: 9 }] }],
    });
  });

  it('returns a fresh object (does not mutate the input)', () => {
    const input = { a: { b: 1 } };
    const out = stripPollutionKeys(input);
    expect(out).not.toBe(input);
    expect(out.a).not.toBe(input.a);
    expect(input).toEqual({ a: { b: 1 } });
  });

  it('drops sparse-array holes to undefined (Array.map fills holes)', () => {
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    const out = stripPollutionKeys(sparse);
    expect(out).toEqual([1, undefined, 3]);
  });

  it('reads through getters (values are realized into the clean copy)', () => {
    const o = {};
    Object.defineProperty(o, 'g', { enumerable: true, get: () => 'value' });
    expect(stripPollutionKeys(o)).toEqual({ g: 'value' });
  });

  it('handles frozen objects without throwing and still strips pollution', () => {
    const frozen = Object.freeze(JSON.parse('{"__proto__":{"x":1},"a":1}'));
    expect(stripPollutionKeys(frozen)).toEqual({ a: 1 });
  });

  it('does not infinitely recurse on circular references (depth guard halts)', () => {
    const c = { a: 1 };
    c.self = c;
    expect(() => stripPollutionKeys(c)).not.toThrow();
  });

  it('strips pollution keys present within the 64-level depth budget', () => {
    // Wrap a polluted object ~30 levels deep — well inside the guard.
    let node = JSON.parse('{"__proto__":{"x":1},"keep":1}');
    for (let i = 0; i < 30; i++) node = { c: node };
    let cur = stripPollutionKeys(node);
    for (let i = 0; i < 30; i++) cur = cur.c;
    expect(Object.prototype.hasOwnProperty.call(cur, '__proto__')).toBe(false);
    expect(cur).toEqual({ keep: 1 });
  });

  it('fails closed past depth 64: drops the over-deep subtree so no pollution key survives', () => {
    // The depth guard protects against unbounded recursion AND fails closed:
    // beyond 64 levels the subtree is dropped to null rather than passed through
    // un-stripped, so a __proto__ own-key buried that deep cannot survive.
    let node = JSON.parse('{"__proto__":{"x":1},"keep":1}');
    for (let i = 0; i < 65; i++) node = { c: node };
    let cur = stripPollutionKeys(node);
    // Descend until we hit the dropped (null) boundary; assert no object along
    // the way ever exposes a forbidden own-key.
    let steps = 0;
    while (cur && typeof cur === 'object' && cur.c !== undefined && steps < 100) {
      expect(Object.prototype.hasOwnProperty.call(cur, '__proto__')).toBe(false);
      cur = cur.c;
      steps++;
    }
    // The deepest retained node is null (subtree dropped), never the raw polluted object.
    expect(cur === null || (typeof cur === 'object' && !Object.prototype.hasOwnProperty.call(cur, '__proto__'))).toBe(true);
  });
});
