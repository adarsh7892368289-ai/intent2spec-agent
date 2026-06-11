// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

import { sanitize } from '../../src/renderer/utils/sanitize.js';

// sanitize() is a DOM-based escaper: it writes the input as a text node
// (el.textContent) and reads back el.innerHTML. The browser/jsdom HTML
// serializer escapes the markup-significant characters (& < >) when
// serializing text content, so any HTML the caller tries to smuggle in comes
// back as inert, displayable text rather than live nodes. These tests assert
// that the output is never parseable as the original markup, by both checking
// the escaped string AND round-tripping the result back through a parser to
// confirm no script/handler/element survives.

/**
 * Parse the sanitized output as HTML and return the resulting fragment so we
 * can assert the dangerous content did NOT materialize as real DOM.
 */
function parseAsHtml(htmlString) {
  const container = document.createElement('div');
  container.innerHTML = htmlString;
  return container;
}

describe('sanitize — safe text preservation', () => {
  it('returns plain text unchanged', () => {
    expect(sanitize('hello')).toBe('hello');
  });

  it('preserves text with safe punctuation and whitespace', () => {
    expect(sanitize('Hello, World! (test) 100%')).toBe('Hello, World! (test) 100%');
  });

  it('coerces a number to its string form', () => {
    expect(sanitize(123)).toBe('123');
  });

  it('coerces a boolean to its string form', () => {
    expect(sanitize(true)).toBe('true');
  });

  it('returns empty string for null', () => {
    expect(sanitize(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(sanitize(undefined)).toBe('');
  });

  it('returns empty string for an empty string', () => {
    expect(sanitize('')).toBe('');
  });
});

describe('sanitize — HTML entity / character escaping', () => {
  it('escapes the ampersand', () => {
    expect(sanitize('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('escapes a bare less-than character', () => {
    expect(sanitize('a < b')).toBe('a &lt; b');
  });

  it('escapes a bare greater-than character', () => {
    expect(sanitize('a > b')).toBe('a &gt; b');
  });

  it('preserves pre-existing HTML entities by escaping their ampersand (no double-decode)', () => {
    // Input is the literal text "&lt;" — the user typed an entity. It must be
    // displayed verbatim, so the & is escaped and the result reads "&amp;lt;".
    expect(sanitize('&lt;')).toBe('&amp;lt;');
  });

  it('does not decode numeric character references in the input', () => {
    expect(sanitize('&#60;script&#62;')).toBe('&amp;#60;script&amp;#62;');
  });
});

describe('sanitize — neutralizes <script> injection', () => {
  it('escapes a full script tag so it is inert text', () => {
    const out = sanitize('<script>alert(1)</script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    // Round-trip: parsing the output yields zero <script> elements.
    expect(parseAsHtml(out).querySelector('script')).toBeNull();
  });

  it('does not produce a live script element when output is parsed', () => {
    const out = sanitize('<script src="evil.js"></script>');
    const parsed = parseAsHtml(out);
    expect(parsed.getElementsByTagName('script').length).toBe(0);
    // The original angle brackets must have been escaped.
    expect(out).not.toContain('<script');
  });

  it('neutralizes a script tag embedded mid-text', () => {
    const out = sanitize('before<script>x()</script>after');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(parseAsHtml(out).querySelector('script')).toBeNull();
  });
});

describe('sanitize — neutralizes event-handler attribute payloads', () => {
  it('escapes an <img onerror=...> payload', () => {
    const out = sanitize('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('img')).toBeNull();
  });

  it('escapes an onclick handler on an anchor', () => {
    const out = sanitize('<a href="#" onclick="steal()">x</a>');
    expect(out).not.toContain('<a ');
    expect(out).toContain('&lt;a');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('a')).toBeNull();
  });

  it('escapes an svg onload payload', () => {
    const out = sanitize('<svg onload=alert(1)>');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('svg')).toBeNull();
    expect(out).toContain('&lt;svg');
  });
});

describe('sanitize — neutralizes javascript: URLs', () => {
  it('does not create a live anchor with a javascript: href', () => {
    const out = sanitize('<a href="javascript:alert(1)">click</a>');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('a')).toBeNull();
    // The literal text may still mention javascript: — but as inert text only.
    expect(out).not.toContain('<a ');
  });

  it('leaves a bare javascript: string as inert text (no anchor)', () => {
    const out = sanitize('javascript:alert(document.cookie)');
    // No tags at all in input, so it round-trips as plain text.
    expect(out).toBe('javascript:alert(document.cookie)');
    expect(parseAsHtml(out).querySelector('a')).toBeNull();
  });
});

describe('sanitize — adversarial / nested / encoded payloads', () => {
  it('does not allow a nested/broken script tag to reconstitute', () => {
    // Classic filter-bypass: a naive regex strip of <script> would leave an
    // inner <script>. A DOM-text escaper has no such weakness.
    const out = sanitize('<scr<script>ipt>alert(1)</scr</script>ipt>');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('script')).toBeNull();
    expect(out).not.toContain('<script');
  });

  it('neutralizes an uppercase/mixed-case SCRIPT tag', () => {
    const out = sanitize('<SCRIPT>alert(1)</SCRIPT>');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('script')).toBeNull();
    expect(out.toLowerCase()).toContain('&lt;script&gt;');
  });

  it('neutralizes an iframe with a srcdoc payload', () => {
    const out = sanitize('<iframe srcdoc="<script>alert(1)</script>"></iframe>');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('iframe')).toBeNull();
    expect(parsed.querySelector('script')).toBeNull();
    expect(out).not.toContain('<iframe');
  });

  it('escapes an HTML-comment breakout attempt', () => {
    const out = sanitize('<!--<img src=x onerror=alert(1)>-->');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('img')).toBeNull();
    // The comment delimiter must be escaped, not preserved as a real comment.
    expect(out).toContain('&lt;!--');
  });

  it('escapes a CDATA / malformed-tag breakout attempt', () => {
    const out = sanitize('<![CDATA[<script>alert(1)</script>]]>');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('script')).toBeNull();
    expect(out).not.toContain('<script');
  });

  it('treats a literal backslash-x-style encoded payload as inert text', () => {
    // \x3c is NOT decoded by the HTML serializer; it stays as literal chars.
    const out = sanitize('\\x3cscript\\x3ealert(1)\\x3c/script\\x3e');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('script')).toBeNull();
    expect(out).toContain('\\x3cscript');
  });

  it('does not let a percent-encoded payload become markup', () => {
    const out = sanitize('%3Cscript%3Ealert(1)%3C/script%3E');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('script')).toBeNull();
    // sanitize does not URL-decode, so the %3C stays literal.
    expect(out).toBe('%3Cscript%3Ealert(1)%3C/script%3E');
  });

  it('handles a null byte embedded in a script payload without producing a tag', () => {
    const out = sanitize('<scri\0pt>alert(1)</script>');
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('script')).toBeNull();
    expect(out).not.toContain('<script>');
  });

  it('neutralizes a multi-vector payload (script + img onerror + anchor js url)', () => {
    const payload =
      '<script>x()</script><img src=x onerror=alert(1)><a href="javascript:void(0)">go</a>';
    const out = sanitize(payload);
    const parsed = parseAsHtml(out);
    expect(parsed.querySelector('script')).toBeNull();
    expect(parsed.querySelector('img')).toBeNull();
    expect(parsed.querySelector('a')).toBeNull();
    // The whole thing serialized as a single inert text node.
    expect(parsed.childNodes.length).toBe(1);
    expect(parsed.firstChild.nodeType).toBe(document.TEXT_NODE);
  });

  it('preserves unicode text content without altering it', () => {
    const out = sanitize('café — naïve — 日本語 — 🎉');
    expect(out).toBe('café — naïve — 日本語 — 🎉');
  });

  it('round-trips arbitrary safe text losslessly through a text-content decode', () => {
    const input = 'a & b < c > d';
    const out = sanitize(input);
    const parsed = parseAsHtml(out);
    // Decoding the escaped output yields exactly the original input.
    expect(parsed.textContent).toBe(input);
  });
});
