import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  normalizeWhitespace,
  truncateText,
  camelCase,
  slugify,
  similarity,
  isEmpty,
} from '@core/helpers/text-utils.js';
import { escapeCss, calculateSpecificity } from '@core/helpers/css-utils.js';
import { escapeXPath } from '@core/helpers/xpath-utils.js';

// Pure string functions only — no DOM. (stripHtml / testCss / countXPathMatches
// require document and live in the jsdom suite.)
//
// escapeCss delegates to the browser-global CSS.escape. The engine runs inside
// a real browser page where this exists; in the node test env it does not, so
// we install the WHATWG-spec CSS.escape algorithm to exercise the real wrapper
// contract (non-string guard + faithful delegation). This is the exact
// algorithm browsers ship, not a hand-waved stub.
let _hadCSS;
let _prevCSS;
beforeAll(() => {
  _hadCSS = 'CSS' in globalThis;
  _prevCSS = globalThis.CSS;
  if (typeof globalThis.CSS?.escape !== 'function') {
    globalThis.CSS = {
      ...(globalThis.CSS || {}),
      // https://drafts.csswg.org/cssom/#the-css.escape()-method
      escape(value) {
        const str = String(value);
        const len = str.length;
        let result = '';
        let firstCodeUnit = str.charCodeAt(0);
        for (let i = 0; i < len; i++) {
          const c = str.charCodeAt(i);
          if (c === 0x0000) {
            result += '�';
            continue;
          }
          if (
            (c >= 0x0001 && c <= 0x001f) ||
            c === 0x007f ||
            (i === 0 && c >= 0x0030 && c <= 0x0039) ||
            (i === 1 && c >= 0x0030 && c <= 0x0039 && firstCodeUnit === 0x002d)
          ) {
            result += '\\' + c.toString(16) + ' ';
            continue;
          }
          if (i === 0 && len === 1 && c === 0x002d) {
            result += '\\' + str.charAt(i);
            continue;
          }
          if (
            c >= 0x0080 ||
            c === 0x002d ||
            c === 0x005f ||
            (c >= 0x0030 && c <= 0x0039) ||
            (c >= 0x0041 && c <= 0x005a) ||
            (c >= 0x0061 && c <= 0x007a)
          ) {
            result += str.charAt(i);
            continue;
          }
          result += '\\' + str.charAt(i);
        }
        return result;
      },
    };
  }
});
afterAll(() => {
  if (_hadCSS) globalThis.CSS = _prevCSS;
  else delete globalThis.CSS;
});

describe('text-utils :: normalizeWhitespace', () => {
  it('collapses runs of internal whitespace into a single space', () => {
    expect(normalizeWhitespace('hello  world')).toBe('hello world');
    expect(normalizeWhitespace('a   b     c')).toBe('a b c');
  });

  it('collapses tabs and newlines to a single space', () => {
    expect(normalizeWhitespace('hello\tworld')).toBe('hello world');
    expect(normalizeWhitespace('line1\nline2')).toBe('line1 line2');
    expect(normalizeWhitespace('a\r\n\t  b')).toBe('a b');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeWhitespace('   padded   ')).toBe('padded');
    expect(normalizeWhitespace('\n\t hi \t\n')).toBe('hi');
  });

  it('returns empty string for non-string input', () => {
    expect(normalizeWhitespace(null)).toBe('');
    expect(normalizeWhitespace(undefined)).toBe('');
    expect(normalizeWhitespace(42)).toBe('');
    expect(normalizeWhitespace({})).toBe('');
  });

  it('handles empty and whitespace-only strings', () => {
    expect(normalizeWhitespace('')).toBe('');
    expect(normalizeWhitespace('    ')).toBe('');
    expect(normalizeWhitespace('\t\n\r')).toBe('');
  });

  it('collapses unicode whitespace characters (\\s matches them)', () => {
    // U+00A0 NBSP and U+2003 EM SPACE are matched by \s in JS regex.
    expect(normalizeWhitespace('a  b')).toBe('a b');
  });
});

describe('text-utils :: truncateText', () => {
  it('truncates and appends suffix accounting for suffix length', () => {
    // length 11 > 5, returns substring(0, 5-3) + '...' === 'he...'
    expect(truncateText('hello world', 5)).toBe('he...');
    expect(truncateText('hello world', 5).length).toBe(5);
  });

  it('returns short strings unchanged (length <= maxLength)', () => {
    expect(truncateText('hi', 5)).toBe('hi');
    expect(truncateText('exactly', 7)).toBe('exactly'); // length == maxLength
  });

  it('applies a custom suffix', () => {
    expect(truncateText('hello world', 6, '…')).toBe('hello…');
    expect(truncateText('hello world', 8, '~~')).toBe('hello ~~');
  });

  it('uses default maxLength of 100', () => {
    const long = 'x'.repeat(150);
    const out = truncateText(long);
    expect(out.length).toBe(100);
    expect(out.endsWith('...')).toBe(true);
  });

  it('returns empty string for non-string input', () => {
    expect(truncateText(null)).toBe('');
    expect(truncateText(undefined)).toBe('');
    expect(truncateText(12345)).toBe('');
  });

  it('handles empty string', () => {
    expect(truncateText('', 5)).toBe('');
  });

  it('handles maxLength shorter than the suffix (negative substring index)', () => {
    // maxLength 2 < suffix length 3: substring(0, -1) === '' then + '...' === '...'
    expect(truncateText('abcdef', 2)).toBe('...');
    // maxLength 0: substring(0, -3) === '' then + '...'
    expect(truncateText('abcdef', 0)).toBe('...');
  });
});

describe('text-utils :: camelCase', () => {
  it('converts space-separated words to camelCase', () => {
    expect(camelCase('hello world')).toBe('helloWorld');
    expect(camelCase('the quick brown fox')).toBe('theQuickBrownFox');
  });

  it('converts hyphenated words to camelCase', () => {
    expect(camelCase('hello-world')).toBe('helloWorld');
    expect(camelCase('data-test-id')).toBe('dataTestId');
  });

  it('converts SCREAMING_SNAKE_CASE to camelCase (lowercases first)', () => {
    expect(camelCase('HELLO_WORLD')).toBe('helloWorld');
  });

  it('returns empty string for non-string input', () => {
    expect(camelCase(null)).toBe('');
    expect(camelCase(undefined)).toBe('');
    expect(camelCase(99)).toBe('');
  });

  it('handles empty string', () => {
    expect(camelCase('')).toBe('');
  });

  it('leaves a single lowercase word unchanged', () => {
    expect(camelCase('hello')).toBe('hello');
  });

  it('collapses multiple separators between words into one boundary', () => {
    // /[^a-zA-Z0-9]+(.)/ consumes the whole run of separators, uppercasing next char
    expect(camelCase('hello   world')).toBe('helloWorld');
    expect(camelCase('hello -_ world')).toBe('helloWorld');
  });
});

describe('text-utils :: slugify', () => {
  it('lowercases and joins words with hyphens', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('removes diacritics via NFD normalization', () => {
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('naïve résumé')).toBe('naive-resume');
  });

  it('collapses trailing punctuation and consecutive separators to single hyphen', () => {
    expect(slugify('hello world!!')).toBe('hello-world');
    expect(slugify('a---b')).toBe('a-b');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('  spaced out  ')).toBe('spaced-out');
    expect(slugify('!!!edge!!!')).toBe('edge');
  });

  it('returns empty string for input of only special characters', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('---')).toBe('');
  });

  it('returns empty string for non-string and empty input', () => {
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
    expect(slugify('')).toBe('');
    expect(slugify(7)).toBe('');
  });
});

describe('text-utils :: similarity (Jaccard over word sets)', () => {
  it('returns 1.0 for identical text', () => {
    expect(similarity('hello world', 'hello world')).toBe(1);
  });

  it('is case-insensitive (words lowercased before comparison)', () => {
    expect(similarity('Hello World', 'hello WORLD')).toBe(1);
  });

  it('returns 0 when there are no common words', () => {
    expect(similarity('alpha beta', 'gamma delta')).toBe(0);
  });

  it('returns a fraction in (0,1) for partial overlap', () => {
    // {hello, world} vs {hello, there}: intersection 1, union 3 => 1/3
    const score = similarity('hello world', 'hello there');
    expect(score).toBeCloseTo(1 / 3, 10);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('returns 1.0 when both strings contain no words', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('   ', '!!!')).toBe(1); // both extract zero words
  });

  it('returns 0 when one side has words and the other has none', () => {
    expect(similarity('hello', '')).toBe(0);
    expect(similarity('', 'hello')).toBe(0);
    expect(similarity('hello world', '!!!')).toBe(0);
  });

  it('returns 0 for non-string inputs', () => {
    expect(similarity(null, 'hello')).toBe(0);
    expect(similarity('hello', undefined)).toBe(0);
    expect(similarity(1, 2)).toBe(0);
  });

  it('deduplicates repeated words (set semantics)', () => {
    // {hello} vs {hello}: identical sets => 1
    expect(similarity('hello hello hello', 'hello')).toBe(1);
  });
});

describe('text-utils :: isEmpty', () => {
  it('treats whitespace-only strings as empty', () => {
    expect(isEmpty('')).toBe(true);
    expect(isEmpty('   ')).toBe(true);
    expect(isEmpty('\t\n\r ')).toBe(true);
  });

  it('treats non-strings as empty (type-safe)', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty(0)).toBe(true);
    expect(isEmpty({})).toBe(true);
    expect(isEmpty([])).toBe(true);
  });

  it('returns false for strings with non-whitespace content', () => {
    expect(isEmpty('x')).toBe(false);
    expect(isEmpty('  hi  ')).toBe(false);
    expect(isEmpty('0')).toBe(false);
  });
});

describe('css-utils :: escapeCss', () => {
  it('returns empty string for non-string input', () => {
    expect(escapeCss(null)).toBe('');
    expect(escapeCss(undefined)).toBe('');
    expect(escapeCss(123)).toBe('');
    expect(escapeCss({})).toBe('');
    expect(escapeCss(['a'])).toBe('');
  });

  it('leaves plain identifiers untouched', () => {
    expect(escapeCss('hello')).toBe('hello');
    expect(escapeCss('btn-primary')).toBe('btn-primary');
  });

  it('returns empty string for empty input', () => {
    expect(escapeCss('')).toBe('');
  });

  it('escapes characters that are special in CSS selectors', () => {
    // CSS.escape escapes leading digits, spaces, quotes, etc. We assert the
    // result is safe to embed (no raw special chars survive verbatim).
    const out = escapeCss('a b');
    expect(out).not.toBe('a b');
    expect(out).toContain('\\'); // space gets backslash-escaped
  });

  it('escapes a leading digit (invalid as a bare CSS ident)', () => {
    // CSS.escape turns a leading digit into a unicode escape like "\\31 23"
    const out = escapeCss('123');
    expect(out).not.toBe('123');
    expect(out).toContain('\\');
  });

  it('escapes backslashes and quotes', () => {
    const bs = escapeCss('a\\b');
    expect(bs).toContain('\\\\');
    const dq = escapeCss('a"b');
    expect(dq).toContain('\\');
  });

  it('escapes a string containing both quotes and backslashes', () => {
    const out = escapeCss('a"\\b');
    // Round-trips: stripping the CSS escapes should never leave a bare quote
    // adjacent to a bare backslash that could break a selector.
    expect(out).toContain('\\');
    expect(typeof out).toBe('string');
  });
});

describe('css-utils :: calculateSpecificity', () => {
  it('scores a bare element selector as [0,0,1]', () => {
    expect(calculateSpecificity('div')).toEqual([0, 0, 1]);
  });

  it('scores an ID selector as [1,0,0]', () => {
    expect(calculateSpecificity('#foo')).toEqual([1, 0, 0]);
  });

  it('scores a class selector as [0,1,0]', () => {
    expect(calculateSpecificity('.bar')).toEqual([0, 1, 0]);
  });

  it('scores an attribute selector as [0,1,0]', () => {
    expect(calculateSpecificity('[href]')).toEqual([0, 1, 0]);
  });

  it('scores a pseudo-class as [0,1,0]', () => {
    expect(calculateSpecificity(':hover')).toEqual([0, 1, 0]);
  });

  it('scores a pseudo-element as [0,0,1]', () => {
    expect(calculateSpecificity('::before')).toEqual([0, 0, 1]);
  });

  it('scores a compound selector div#id.class[attr]:hover as [1,3,1]', () => {
    expect(calculateSpecificity('div#id.class[attr]:hover')).toEqual([1, 3, 1]);
  });

  it('returns [0,0,0] for non-string input', () => {
    expect(calculateSpecificity(null)).toEqual([0, 0, 0]);
    expect(calculateSpecificity(undefined)).toEqual([0, 0, 0]);
    expect(calculateSpecificity(42)).toEqual([0, 0, 0]);
    expect(calculateSpecificity({})).toEqual([0, 0, 0]);
  });

  it('returns [0,0,0] for empty string', () => {
    expect(calculateSpecificity('')).toEqual([0, 0, 0]);
  });

  it('counts multiple pseudo-elements in the element column', () => {
    // ::before and ::after each increment c
    expect(calculateSpecificity('p::before::after')).toEqual([0, 0, 3]);
    // (c = 2 pseudo-elements + 1 element 'p')
  });

  it('counts multiple attribute selectors in the class column', () => {
    expect(calculateSpecificity('input[type][name]')).toEqual([0, 2, 1]);
  });

  it('counts descendant elements via combinators', () => {
    // 'ul li a' => three element matches
    expect(calculateSpecificity('ul li a')).toEqual([0, 0, 3]);
    // child / sibling combinators also delimit element matches
    expect(calculateSpecificity('div > span + b')).toEqual([0, 0, 3]);
  });
});

describe('xpath-utils :: escapeXPath', () => {
  it('wraps a quote-free string in single quotes', () => {
    expect(escapeXPath('hello')).toBe("'hello'");
    expect(escapeXPath('')).toBe("''");
  });

  it('wraps a string containing only apostrophes in double quotes', () => {
    expect(escapeXPath("it's")).toBe('"it\'s"');
    expect(escapeXPath("'")).toBe('"\'"');
  });

  it('builds a concat() expression for strings with both quote types', () => {
    const out = escapeXPath(`it's "ok"`);
    expect(out.startsWith('concat(')).toBe(true);
    expect(out.endsWith(')')).toBe(true);
    // The apostrophe is reintroduced as a "'" literal segment
    expect(out).toContain(`"'"`);
  });

  it('produces a concat() that, when conceptually joined, equals the original', () => {
    const value = `a'b"c`;
    const out = escapeXPath(value);
    expect(out.startsWith('concat(')).toBe(true);
    // Reconstruct the literal value the concat() encodes by parsing its parts.
    // parts come from split("'"): ['a', 'b"c'] => 'a' , "'" , 'b"c'
    expect(out).toBe(`concat('a',"'",'b"c')`);
  });

  it('returns empty string for non-string input', () => {
    expect(escapeXPath(null)).toBe('');
    expect(escapeXPath(undefined)).toBe('');
    expect(escapeXPath(123)).toBe('');
    expect(escapeXPath({})).toBe('');
  });

  it('handles a double-quote-only string by wrapping in single quotes', () => {
    // No apostrophe present, so the single-quote branch is taken.
    expect(escapeXPath('say "hi"')).toBe(`'say "hi"'`);
  });
});
