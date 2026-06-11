import { describe, it, expect } from 'vitest';

import XPathStrategies from '@core/enrichment/xpath-strategies.js';
import CSSEngine from '@core/enrichment/css-engine.js';
import XPathEngine from '@core/enrichment/xpath-engine.js';

// ---------------------------------------------------------------------------
// XPathStrategies.isStableId — semantic IDs stable; hashed/framework/positional unstable
// ---------------------------------------------------------------------------
describe('XPathStrategies.isStableId', () => {
  it('accepts a semantic kebab-case id', () => {
    expect(XPathStrategies.isStableId('user-profile')).toBe(true);
    expect(XPathStrategies.isStableId('submit-button')).toBe(true);
    expect(XPathStrategies.isStableId('main-nav')).toBe(true);
  });

  it('rejects numeric-only ids', () => {
    expect(XPathStrategies.isStableId('12345')).toBe(false);
    expect(XPathStrategies.isStableId('7')).toBe(false);
  });

  it('rejects long all-digit ids (8+)', () => {
    expect(XPathStrategies.isStableId('12345678')).toBe(false);
    expect(XPathStrategies.isStableId('1234567890123')).toBe(false); // 13-digit timestamp-like
  });

  it('rejects UUID-prefixed ids (case-insensitive)', () => {
    expect(XPathStrategies.isStableId('a1b2c3d4-e5f6-7890')).toBe(false);
    expect(XPathStrategies.isStableId('A1B2C3D4-E5F6-aaaa')).toBe(false);
  });

  it('rejects framework-generated ids (ember/react/vue/angular/aura/uid/gen/temp)', () => {
    expect(XPathStrategies.isStableId('ember42')).toBe(false);
    expect(XPathStrategies.isStableId('react9')).toBe(false);
    expect(XPathStrategies.isStableId('vue3')).toBe(false);
    expect(XPathStrategies.isStableId('angular1')).toBe(false);
    expect(XPathStrategies.isStableId('uid-999')).toBe(false);
    expect(XPathStrategies.isStableId('gen5')).toBe(false);
    expect(XPathStrategies.isStableId('temp-12')).toBe(false);
    expect(XPathStrategies.isStableId('temp_3')).toBe(false);
  });

  it('rejects Salesforce / Lightning datatable patterns', () => {
    expect(XPathStrategies.isStableId('lightning-button-1')).toBe(false);
    expect(XPathStrategies.isStableId('check-button-label-1-2')).toBe(false);
    expect(XPathStrategies.isStableId('aura-123')).toBe(false);
    expect(XPathStrategies.isStableId('sldsModal3')).toBe(false);
  });

  it('rejects positional / index-suffixed ids', () => {
    expect(XPathStrategies.isStableId('row-3-7')).toBe(false); // -\d+-\d+$
    expect(XPathStrategies.isStableId('item-42')).toBe(false); // -\d{2,}$
    expect(XPathStrategies.isStableId('cell-1-2-3')).toBe(false); // -\d+-\d+-\d+
  });

  it('rejects ids that are too short or too long', () => {
    expect(XPathStrategies.isStableId('a')).toBe(false); // len < 2
    expect(XPathStrategies.isStableId('x'.repeat(201))).toBe(false); // len > 200
  });

  it('rejects null/empty/undefined input without throwing', () => {
    expect(XPathStrategies.isStableId('')).toBe(false);
    expect(XPathStrategies.isStableId(null)).toBe(false);
    expect(XPathStrategies.isStableId(undefined)).toBe(false);
  });

  it('accepts at the length boundaries (2 and 200 chars)', () => {
    expect(XPathStrategies.isStableId('ab')).toBe(true); // len === 2
    expect(XPathStrategies.isStableId('a'.repeat(200))).toBe(true); // len === 200
  });
});

// ---------------------------------------------------------------------------
// XPathStrategies.isStableValue
// ---------------------------------------------------------------------------
describe('XPathStrategies.isStableValue', () => {
  it('accepts a stable semantic value', () => {
    expect(XPathStrategies.isStableValue('user-123')).toBe(true);
    expect(XPathStrategies.isStableValue('save')).toBe(true);
  });

  it('rejects long all-digit values (8+) and 13-digit timestamps', () => {
    expect(XPathStrategies.isStableValue('12345678')).toBe(false);
    expect(XPathStrategies.isStableValue('1234567890123')).toBe(false);
  });

  it('rejects UUID-shaped values', () => {
    expect(XPathStrategies.isStableValue('1234abcd-5678-9abc')).toBe(false);
  });

  it('rejects framework signatures', () => {
    expect(XPathStrategies.isStableValue('ember12')).toBe(false);
    expect(XPathStrategies.isStableValue('react7')).toBe(false);
    expect(XPathStrategies.isStableValue('data-aura-rendered-by')).toBe(false);
    expect(XPathStrategies.isStableValue('tt-for-99')).toBe(false);
  });

  it('rejects positional patterns', () => {
    expect(XPathStrategies.isStableValue('x-3-7')).toBe(false); // -\d+-\d+$
  });

  it('rejects empty, null, and non-string values', () => {
    expect(XPathStrategies.isStableValue('')).toBe(false);
    expect(XPathStrategies.isStableValue(null)).toBe(false);
    expect(XPathStrategies.isStableValue(undefined)).toBe(false);
    expect(XPathStrategies.isStableValue(123)).toBe(false);
    expect(XPathStrategies.isStableValue({})).toBe(false);
  });

  it('honours length boundaries (1 accepted, 201 rejected)', () => {
    expect(XPathStrategies.isStableValue('a')).toBe(true); // len === 1
    expect(XPathStrategies.isStableValue('a'.repeat(201))).toBe(false); // len > 200
  });
});

// ---------------------------------------------------------------------------
// XPathStrategies.isStableClass
// ---------------------------------------------------------------------------
describe('XPathStrategies.isStableClass', () => {
  it('accepts conventional / BEM-ish class names', () => {
    expect(XPathStrategies.isStableClass('btn-primary')).toBe(true);
    expect(XPathStrategies.isStableClass('card__header')).toBe(true);
    expect(XPathStrategies.isStableClass('nav-item-active')).toBe(true);
  });

  it('rejects Material-UI generated classes', () => {
    expect(XPathStrategies.isStableClass('MuiButton-root-123')).toBe(false);
    expect(XPathStrategies.isStableClass('makeStyles-root-42')).toBe(false);
  });

  it('rejects CSS-in-JS / Emotion / styled-components classes', () => {
    expect(XPathStrategies.isStableClass('css-1q2w3e')).toBe(false);
    expect(XPathStrategies.isStableClass('emotion-12')).toBe(false);
    expect(XPathStrategies.isStableClass('sc-foo-bar')).toBe(false);
  });

  it('rejects JSS and LWC scoped classes', () => {
    expect(XPathStrategies.isStableClass('jss456')).toBe(false);
    expect(XPathStrategies.isStableClass('lwc-2h3j4k')).toBe(false);
  });

  it('rejects short-prefix + long-digit hashed classes', () => {
    expect(XPathStrategies.isStableClass('ab12345')).toBe(false); // ^[a-z]{1,3}\d{5,}$
    expect(XPathStrategies.isStableClass('_a1b2c3')).toBe(false); // ^_[a-z0-9]{6,}$
  });

  it('rejects empty / whitespace-only / non-string input', () => {
    expect(XPathStrategies.isStableClass('')).toBe(false);
    expect(XPathStrategies.isStableClass('   ')).toBe(false);
    expect(XPathStrategies.isStableClass(null)).toBe(false);
    expect(XPathStrategies.isStableClass(undefined)).toBe(false);
    expect(XPathStrategies.isStableClass(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// XPathStrategies.isStaticText
// ---------------------------------------------------------------------------
describe('XPathStrategies.isStaticText', () => {
  it('accepts ordinary visible labels', () => {
    expect(XPathStrategies.isStaticText('Click Me')).toBe(true);
    expect(XPathStrategies.isStaticText('Submit Order')).toBe(true);
  });

  it('rejects numeric-only text', () => {
    expect(XPathStrategies.isStaticText('12345')).toBe(false);
    expect(XPathStrategies.isStaticText('42')).toBe(false);
  });

  it('rejects date and time strings', () => {
    expect(XPathStrategies.isStaticText('01/15/2024')).toBe(false);
    expect(XPathStrategies.isStaticText('10:30')).toBe(false);
    expect(XPathStrategies.isStaticText('9:05 AM')).toBe(false);
  });

  it('rejects loading / processing indicators (case-insensitive)', () => {
    expect(XPathStrategies.isStaticText('loading')).toBe(false);
    expect(XPathStrategies.isStaticText('Loading...')).toBe(false);
    expect(XPathStrategies.isStaticText('Processing your request')).toBe(false);
  });

  it('rejects currency values', () => {
    expect(XPathStrategies.isStaticText('$99.99')).toBe(false);
    expect(XPathStrategies.isStaticText('$0.50')).toBe(false);
  });

  it('rejects UUID-shaped text', () => {
    expect(XPathStrategies.isStaticText('a1b2c3d4-e5f6-7777')).toBe(false);
  });

  it('rejects text below/above length bounds and non-strings', () => {
    expect(XPathStrategies.isStaticText('a')).toBe(false); // len < 2
    expect(XPathStrategies.isStaticText('x'.repeat(201))).toBe(false); // len > 200
    expect(XPathStrategies.isStaticText('')).toBe(false);
    expect(XPathStrategies.isStaticText(null)).toBe(false);
    expect(XPathStrategies.isStaticText(undefined)).toBe(false);
    expect(XPathStrategies.isStaticText(123)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSSEngine.isStableId — looser heuristic than XPathStrategies
// ---------------------------------------------------------------------------
describe('CSSEngine.isStableId', () => {
  it('accepts a semantic id', () => {
    expect(CSSEngine.isStableId('user-123')).toBe(true);
    expect(CSSEngine.isStableId('login-form')).toBe(true);
  });

  it('rejects numeric-only ids', () => {
    expect(CSSEngine.isStableId('12345')).toBe(false);
  });

  it('rejects ids containing a 6+ digit run', () => {
    expect(CSSEngine.isStableId('item123456')).toBe(false);
    expect(CSSEngine.isStableId('123456789')).toBe(false);
  });

  it('rejects ids shorter than 3 chars', () => {
    expect(CSSEngine.isStableId('id')).toBe(false); // len 2
    expect(CSSEngine.isStableId('a')).toBe(false);
  });

  it('accepts at the 3-char boundary', () => {
    expect(CSSEngine.isStableId('abc')).toBe(true);
  });

  it('rejects null / empty input', () => {
    expect(CSSEngine.isStableId('')).toBe(false);
    expect(CSSEngine.isStableId(null)).toBe(false);
    expect(CSSEngine.isStableId(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSSEngine.getMeaningfulClasses — pure: reads element.className string only
// ---------------------------------------------------------------------------
describe('CSSEngine.getMeaningfulClasses', () => {
  it('keeps multi-char meaningful classes', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: 'btn btn-primary' }))
      .toEqual(['btn-primary']); // 'btn' is 3 chars -> filtered (length must be > 3)
    expect(CSSEngine.getMeaningfulClasses({ className: 'navbar header-main' }))
      .toEqual(['navbar', 'header-main']);
  });

  it('filters classes of 3 chars or fewer and short-tag+digit patterns', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: 'a1 test-btn h-1' }))
      .toEqual(['test-btn']);
  });

  it('filters state classes (active/selected/hover/focus)', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: 'hover active selected focus' }))
      .toEqual([]);
  });

  it('returns [] for empty className', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: '' })).toEqual([]);
  });

  it('returns [] for null / undefined / non-string className', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: null })).toEqual([]);
    expect(CSSEngine.getMeaningfulClasses({ className: undefined })).toEqual([]);
    expect(CSSEngine.getMeaningfulClasses({ className: 123 })).toEqual([]);
    expect(CSSEngine.getMeaningfulClasses({})).toEqual([]);
  });

  it('collapses arbitrary whitespace between classes', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: '  card-body   modal-footer  ' }))
      .toEqual(['card-body', 'modal-footer']);
  });
});

// ---------------------------------------------------------------------------
// XPathEngine.getUniversalTag — namespace-aware tag projection
// ---------------------------------------------------------------------------
describe('XPathEngine.getUniversalTag', () => {
  it('lowercases plain HTML tag names', () => {
    expect(XPathEngine.getUniversalTag({ namespaceURI: 'http://www.w3.org/1999/xhtml', tagName: 'BUTTON' }))
      .toBe('button');
    expect(XPathEngine.getUniversalTag({ namespaceURI: null, tagName: 'DIV' }))
      .toBe('div');
  });

  it('projects SVG elements to a local-name() predicate', () => {
    expect(XPathEngine.getUniversalTag({ namespaceURI: 'http://www.w3.org/2000/svg', localName: 'svg' }))
      .toBe("*[local-name()='svg']");
    expect(XPathEngine.getUniversalTag({ namespaceURI: 'http://www.w3.org/2000/svg', localName: 'path' }))
      .toBe("*[local-name()='path']");
  });

  it('projects MathML elements to a local-name() predicate', () => {
    expect(XPathEngine.getUniversalTag({ namespaceURI: 'http://www.w3.org/1998/Math/MathML', localName: 'mi' }))
      .toBe("*[local-name()='mi']");
  });

  it('treats a null namespace as plain HTML (uses tagName)', () => {
    expect(XPathEngine.getUniversalTag({ namespaceURI: null, tagName: 'A' })).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// XPathEngine.calculateRobustness — scoring heuristic + monotonicity
// ---------------------------------------------------------------------------
describe('XPathEngine.calculateRobustness', () => {
  it('uses base 100 - tier*4 for a bare path', () => {
    // tag-only path has no bonus/penalty triggers, single segment
    expect(XPathEngine.calculateRobustness('//button', 0)).toBe(100);
    expect(XPathEngine.calculateRobustness('//button', 10)).toBe(60); // 100 - 40
  });

  it('adds a bonus for data-testid', () => {
    const withTestId = XPathEngine.calculateRobustness("//button[@data-testid='x']", 5);
    const withoutTestId = XPathEngine.calculateRobustness('//button', 5);
    expect(withTestId).toBeGreaterThan(withoutTestId);
  });

  it('adds a bonus for a stable id predicate', () => {
    const withId = XPathEngine.calculateRobustness("//button[@id='save']", 5);
    const without = XPathEngine.calculateRobustness('//button', 5);
    expect(withId).toBeGreaterThan(without);
  });

  it('adds a bonus for exact text match', () => {
    const withText = XPathEngine.calculateRobustness("//button[text()='Save']", 5);
    const without = XPathEngine.calculateRobustness('//button', 5);
    expect(withText).toBeGreaterThan(without);
  });

  it('penalises contains(@class) predicates', () => {
    const withClass = XPathEngine.calculateRobustness("//button[contains(@class, 'x')]", 5);
    const without = XPathEngine.calculateRobustness('//button', 5);
    expect(withClass).toBeLessThan(without);
  });

  it('penalises following::/preceding:: axes', () => {
    const withAxis = XPathEngine.calculateRobustness("//div[@id='a']/following::button", 5);
    // same tier baseline that does include the [@id=] bonus but no axis
    const baseline = XPathEngine.calculateRobustness("//div[@id='a']", 5);
    expect(withAxis).toBeLessThan(baseline);
  });

  it('is monotonic in tier: higher tier never scores higher (same xpath)', () => {
    const xpath = "//button[@data-key='row-1']";
    let prev = Infinity;
    for (let tier = 0; tier <= 22; tier++) {
      const score = XPathEngine.calculateRobustness(xpath, tier);
      expect(score).toBeLessThanOrEqual(prev);
      prev = score;
    }
  });

  it('clamps the result into [30, 100]', () => {
    // A deeply-tiered, multi-segment, class+axis path should floor at 30, never below.
    const weak = XPathEngine.calculateRobustness(
      "//div[contains(@class, 'a')]//div//div//div/following::span[contains(@class, 'b')]",
      22
    );
    expect(weak).toBeGreaterThanOrEqual(30);
    expect(weak).toBeLessThanOrEqual(100);

    // A maximally-decorated tier-0 path should cap at 100, never above.
    const strong = XPathEngine.calculateRobustness(
      "//button[@data-testid='x'][@id='y'][@data-key='z'][text()='Hi'][@aria-label='l']",
      0
    );
    expect(strong).toBe(100);
  });

  it('applies a penalty for deeply segmented paths (> 3 // segments)', () => {
    const shallow = XPathEngine.calculateRobustness('//a/b', 0);
    const deep = XPathEngine.calculateRobustness('//a//b//c//d//e', 0);
    expect(deep).toBeLessThan(shallow);
  });
});

// ---------------------------------------------------------------------------
// XPathEngine.selectDiverseFallbacks — dedupe by xpath + truncate to maxCount
// ---------------------------------------------------------------------------
describe('XPathEngine.selectDiverseFallbacks', () => {
  const mk = (xpath, robustness = 50) => ({ xpath, robustness });

  it('returns the list unchanged when length <= maxCount', () => {
    const a = mk('//a');
    const b = mk('//b');
    expect(XPathEngine.selectDiverseFallbacks([a, b], 3)).toEqual([a, b]);
  });

  it('keeps all distinct candidates up to maxCount', () => {
    const a = mk('//a');
    const b = mk('//b');
    const c = mk('//c');
    const d = mk('//d');
    const out = XPathEngine.selectDiverseFallbacks([a, b, c, d], 3);
    expect(out).toEqual([a, b, c]);
  });

  it('filters out duplicate xpaths (keeping the first occurrence)', () => {
    const a = mk('//a', 90);
    const aDup = mk('//a', 10);
    const b = mk('//b', 80);
    const c = mk('//c', 70);
    const out = XPathEngine.selectDiverseFallbacks([a, aDup, b, c], 3);
    expect(out.map((x) => x.xpath)).toEqual(['//a', '//b', '//c']);
    // first occurrence (robustness 90) wins, not the dup
    expect(out[0]).toBe(a);
  });

  it('returns the single candidate when fewer than maxCount provided', () => {
    const a = mk('//only');
    expect(XPathEngine.selectDiverseFallbacks([a], 3)).toEqual([a]);
  });

  it('truncates to maxCount when more distinct candidates exist', () => {
    const items = [mk('//a'), mk('//b'), mk('//c'), mk('//d')];
    const out = XPathEngine.selectDiverseFallbacks(items, 2);
    expect(out.map((x) => x.xpath)).toEqual(['//a', '//b']);
  });

  it('collapses an all-duplicate list down to one entry', () => {
    // length (4) > maxCount (3) so dedupe logic runs; all share the same xpath.
    const items = [mk('//x'), mk('//x'), mk('//x'), mk('//x')];
    const out = XPathEngine.selectDiverseFallbacks(items, 3);
    expect(out.map((x) => x.xpath)).toEqual(['//x']);
  });
});
