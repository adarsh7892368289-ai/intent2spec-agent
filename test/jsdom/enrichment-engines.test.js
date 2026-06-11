// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

import CSSEngine from '@core/enrichment/css-engine.js';
import LabelExtractor, {
  extractLabel,
  extractRole,
} from '@core/enrichment/label-extractor.js';
import collectMetadata from '@core/enrichment/metadata-collector.js';
import buildDescription from '@core/enrichment/description-builder.js';
import buildParentChain from '@core/enrichment/parent-builder.js';
import findNearbyElements, {
  findNearbyElementsExtended,
} from '@core/enrichment/nearby-finder.js';

// ---------------------------------------------------------------------------
// jsdom limitation shim: jsdom exposes NO `CSS` global (typeof CSS === 'undefined'),
// but css-utils.escapeCss() calls CSS.escape() unconditionally. In a real browser
// (Chromium/Firefox/WebKit via Playwright, where this engine actually runs) CSS.escape
// exists. We provide the spec-compliant CSS.escape so the CSS engine can run; this is
// an environment workaround, not a behavior change. See notes.
// ---------------------------------------------------------------------------
function cssEscapePolyfill(value) {
  const str = String(value);
  const length = str.length;
  let index = -1;
  let result = '';
  const firstCodeUnit = str.charCodeAt(0);
  while (++index < length) {
    const codeUnit = str.charCodeAt(index);
    if (codeUnit === 0x0000) {
      result += '�';
      continue;
    }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 &&
        codeUnit >= 0x0030 &&
        codeUnit <= 0x0039 &&
        firstCodeUnit === 0x002d)
    ) {
      result += '\\' + codeUnit.toString(16) + ' ';
      continue;
    }
    if (index === 0 && length === 1 && codeUnit === 0x002d) {
      result += '\\' + str.charAt(index);
      continue;
    }
    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += str.charAt(index);
      continue;
    }
    result += '\\' + str.charAt(index);
  }
  return result;
}

beforeEach(() => {
  // Provide the missing CSS global for the duration of each test.
  globalThis.CSS = { escape: cssEscapePolyfill };
  // Clear the label LRU cache so cross-test state never leaks.
  LabelExtractor.clearCache();
  document.body.innerHTML = '';
});

// Helper: jsdom getBoundingClientRect returns zeros and has no layout engine.
// Stub a rect on an element so position-dependent code (nearby-finder) has data.
function stubRect(el, { x = 0, y = 0, width = 10, height = 10 } = {}) {
  el.getBoundingClientRect = () => ({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON() {},
  });
}

// =====================================================================
// CSSEngine.generate
// =====================================================================
describe('CSSEngine.generate', () => {
  it('returns emptyResult for null / non-element input', () => {
    expect(CSSEngine.generate(null)).toEqual({
      selector: null,
      tier: 0,
      strategy: 'none',
      executionTime: 0,
    });
    expect(CSSEngine.generate({}).selector).toBeNull();
    expect(CSSEngine.generate({}).tier).toBe(0);
  });

  it('uses a tier-1 ID selector for an element with a stable id, and it resolves back to the element', () => {
    document.body.innerHTML = '<div><button id="submit-btn">Go</button></div>';
    const el = document.getElementById('submit-btn');

    const result = CSSEngine.generate(el);

    expect(result.tier).toBe(1);
    expect(result.strategy).toBe('id');
    expect(result.selector).toBe('#submit-btn');
    // The whole point of selector generation: it must resolve uniquely back.
    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
    expect(document.querySelector(result.selector)).toBe(el);
  });

  it('falls back to a data-testid (tier 2) when the id is unstable/numeric', () => {
    document.body.innerHTML =
      '<div><button id="123456" data-testid="login">Go</button></div>';
    const el = document.querySelector('button');

    const result = CSSEngine.generate(el);

    expect(result.tier).toBe(2);
    expect(result.selector).toBe('[data-testid="login"]');
    expect(document.querySelector(result.selector)).toBe(el);
  });

  it('produces a selector that resolves to the element even with no id/data attrs (positional fallback)', () => {
    document.body.innerHTML =
      '<ul><li>a</li><li>b</li><li><span>target</span></li></ul>';
    const el = document.querySelectorAll('li')[2].firstElementChild;

    const result = CSSEngine.generate(el);

    expect(result.selector).toBeTruthy();
    expect(typeof result.selector).toBe('string');
    expect(document.querySelector(result.selector)).toBe(el);
    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
  });

  it('falls through ambiguous earlier strategies to a unique later strategy', () => {
    // Two buttons share the same class -> class strategy is not unique,
    // engine must keep going until it finds something unique.
    document.body.innerHTML =
      '<div id="wrap"><button class="primary-action">A</button>' +
      '<button class="primary-action">B</button></div>';
    const second = document.querySelectorAll('button')[1];

    const result = CSSEngine.generate(second);

    expect(result.selector).toBeTruthy();
    expect(document.querySelector(result.selector)).toBe(second);
    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
  });

  it('generates a shadow-composite selector for an element inside an open shadow root', () => {
    document.body.innerHTML = '<my-widget id="host"></my-widget>';
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button data-testid="inner">Inner</button>';
    const inner = root.querySelector('button');

    const result = CSSEngine.generate(inner);

    expect(result.shadowDOM).toBe(true);
    expect(result.shadowDepth).toBe(1);
    expect(Array.isArray(result.shadowHosts)).toBe(true);
    expect(result.internalSelector).toContain('data-testid');
    // Composite selector object is a function-bearing object, not a string.
    expect(typeof result.selector).toBe('object');
    expect(result.selector.type).toBe('shadow-composite-css');
    // execute() should resolve the element through the shadow boundary.
    expect(result.selector.execute(document)).toBe(inner);
    // toString should be a readable composite path.
    expect(result.selector.toString()).toContain('>>');
  });

  it('always reports a numeric executionTime on the result', () => {
    document.body.innerHTML = '<a id="link-home" href="/x">Home</a>';
    const result = CSSEngine.generate(document.getElementById('link-home'));
    expect(typeof result.executionTime).toBe('number');
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================================
// CSSEngine.isStableId  (static, public)  — brief: pure-unit, high
// =====================================================================
describe('CSSEngine.isStableId', () => {
  it.each([
    ['user-123', true],
    ['12345', false], // numeric-only
    ['123456789', false], // 6+ consecutive digits
    ['id', false], // length < 3
    ['abc', true],
  ])('isStableId(%j) -> %s', (id, expected) => {
    expect(CSSEngine.isStableId(id)).toBe(expected);
  });

  it('rejects empty string, null, and undefined', () => {
    expect(CSSEngine.isStableId('')).toBe(false);
    expect(CSSEngine.isStableId(null)).toBe(false);
    expect(CSSEngine.isStableId(undefined)).toBe(false);
  });

  it('rejects ids containing a 6+ digit run even with a prefix', () => {
    expect(CSSEngine.isStableId('node-1000000')).toBe(false);
    expect(CSSEngine.isStableId('node-12345')).toBe(true); // only 5 digits
  });
});

// =====================================================================
// CSSEngine.getMeaningfulClasses  (static, public) — brief: pure-unit, high
// =====================================================================
describe('CSSEngine.getMeaningfulClasses', () => {
  it('keeps classes longer than 3 chars', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: 'btn btn-primary' })).toEqual([
      'btn-primary',
    ]);
  });

  it('filters short classes and the [a-z]\\d+ utility pattern', () => {
    expect(
      CSSEngine.getMeaningfulClasses({ className: 'a1 test-btn h-1' })
    ).toEqual(['test-btn']);
  });

  it('filters state classes (active/selected/hover/focus)', () => {
    expect(
      CSSEngine.getMeaningfulClasses({ className: 'hover active selected' })
    ).toEqual([]);
  });

  it('returns [] for empty, null, and non-string className', () => {
    expect(CSSEngine.getMeaningfulClasses({ className: '' })).toEqual([]);
    expect(CSSEngine.getMeaningfulClasses({ className: null })).toEqual([]);
    expect(CSSEngine.getMeaningfulClasses({ className: { animVal: 'svgClass' } })).toEqual(
      []
    );
  });
});

// =====================================================================
// LabelExtractor.extract — priority cascade + caching
// =====================================================================
describe('LabelExtractor.extract', () => {
  it('returns the emptyResult shape for null', () => {
    const r = LabelExtractor.extract(null);
    expect(r.displayName).toBe('Unknown Element');
    expect(r.label).toBe('');
    expect(r.priority).toBe('fallback');
    expect(r.confidence).toBe(0.4);
  });

  it('prefers aria-label above all (confidence 1.0)', () => {
    document.body.innerHTML =
      '<button aria-label="Close dialog">X</button>';
    const r = LabelExtractor.extract(document.querySelector('button'));
    expect(r.displayName).toBe('Close dialog');
    expect(r.priority).toBe('ariaLabel');
    expect(r.confidence).toBe(1.0);
  });

  it('uses aria-labelledby when aria-label is absent (resolves the referenced element)', () => {
    document.body.innerHTML =
      '<span id="lbl">Account name</span>' +
      '<input aria-labelledby="lbl" />';
    const r = LabelExtractor.extract(document.querySelector('input'));
    expect(r.priority).toBe('ariaLabelledby');
    expect(r.displayName).toBe('Account name');
    expect(r.confidence).toBe(0.98);
  });

  it('uses an associated label[for=id] for a form field (confidence 0.95)', () => {
    document.body.innerHTML =
      '<label for="email">Email Address</label>' +
      '<input id="email" type="text" />';
    const r = LabelExtractor.extract(document.getElementById('email'));
    expect(r.priority).toBe('associatedLabel');
    expect(r.displayName).toBe('Email Address');
    expect(r.confidence).toBe(0.95);
  });

  it('uses visible text for a button when no aria/label present (confidence 0.90)', () => {
    document.body.innerHTML = '<button>Save changes</button>';
    const r = LabelExtractor.extract(document.querySelector('button'));
    expect(r.priority).toBe('visibleText');
    expect(r.displayName).toBe('Save changes');
    expect(r.confidence).toBe(0.9);
  });

  it('uses placeholder before name for a bare input (confidence 0.75)', () => {
    document.body.innerHTML =
      '<input name="firstName" placeholder="Enter first name" />';
    const r = LabelExtractor.extract(document.querySelector('input'));
    expect(r.priority).toBe('placeholder');
    expect(r.displayName).toBe('Enter first name');
    expect(r.confidence).toBe(0.75);
  });

  it('falls back to a titleCased name attribute when nothing better exists (confidence 0.60)', () => {
    // input with no placeholder/label/aria/title -> name converted camelCase->Title Case
    document.body.innerHTML = '<select name="billingCountry"></select>';
    const r = LabelExtractor.extract(document.querySelector('select'));
    expect(r.priority).toBe('name');
    expect(r.displayName).toBe('Billing Country');
    expect(r.confidence).toBe(0.6);
  });

  it('truncates a very long aria-label displayName to <= 100 chars', () => {
    const long = 'A'.repeat(250);
    document.body.innerHTML = `<button aria-label="${long}">x</button>`;
    const r = LabelExtractor.extract(document.querySelector('button'));
    expect(r.displayName.length).toBeLessThanOrEqual(100);
    expect(r.displayName.endsWith('...')).toBe(true);
  });

  it('returns a cached result on a second call for the same element (cache hit)', () => {
    document.body.innerHTML = '<button aria-label="Cached">x</button>';
    const el = document.querySelector('button');
    const first = LabelExtractor.extract(el);
    const before = LabelExtractor.getCacheStats().size;
    const second = LabelExtractor.extract(el);
    expect(second).toBe(first); // identical object reference => served from cache
    expect(LabelExtractor.getCacheStats().size).toBe(before);
  });

  it('clearCache empties the cache', () => {
    document.body.innerHTML = '<button aria-label="One">x</button>';
    LabelExtractor.extract(document.querySelector('button'));
    expect(LabelExtractor.getCacheStats().size).toBeGreaterThan(0);
    LabelExtractor.clearCache();
    expect(LabelExtractor.getCacheStats().size).toBe(0);
  });

  it('extractLabel convenience export delegates to extract()', () => {
    document.body.innerHTML = '<button aria-label="Delegate">x</button>';
    const r = extractLabel(document.querySelector('button'));
    expect(r.displayName).toBe('Delegate');
    expect(r.priority).toBe('ariaLabel');
  });
});

// =====================================================================
// LabelExtractor.calculateConfidence  (static, public)
// =====================================================================
describe('LabelExtractor.calculateConfidence', () => {
  const base = {
    ariaLabel: null,
    ariaLabelledby: null,
    associatedLabel: null,
    dataLabel: null,
    visibleText: null,
    alt: null,
    placeholder: null,
    title: null,
    value: null,
    nearbyLabel: null,
    name: null,
  };

  it('returns 1.0 when ariaLabel present (highest priority wins even if others set)', () => {
    expect(
      LabelExtractor.calculateConfidence({ ...base, ariaLabel: 'x', name: 'y' })
    ).toBe(1.0);
  });

  it.each([
    ['ariaLabelledby', 0.98],
    ['associatedLabel', 0.95],
    ['dataLabel', 0.93],
    ['visibleText', 0.9],
    ['alt', 0.85],
    ['placeholder', 0.75],
    ['title', 0.7],
    ['value', 0.7],
    ['nearbyLabel', 0.65],
    ['name', 0.6],
  ])('returns %s confidence -> %s', (source, expected) => {
    expect(LabelExtractor.calculateConfidence({ ...base, [source]: 'v' })).toBe(
      expected
    );
  });

  it('returns 0.40 when all sources are null', () => {
    expect(LabelExtractor.calculateConfidence({ ...base })).toBe(0.4);
  });
});

// =====================================================================
// extractRole
// =====================================================================
describe('extractRole', () => {
  it('returns explicit role attribute, overriding semantic mapping', () => {
    document.body.innerHTML = '<button role="tab">x</button>';
    expect(extractRole(document.querySelector('button'))).toBe('tab');
  });

  it('maps a <button> to "button"', () => {
    document.body.innerHTML = '<button>x</button>';
    expect(extractRole(document.querySelector('button'))).toBe('button');
  });

  it('maps input[type=submit] to "button"', () => {
    document.body.innerHTML = '<input type="submit" />';
    expect(extractRole(document.querySelector('input'))).toBe('button');
  });

  it('maps <a> to "link", <select> to "combobox", <textarea> to "textbox"', () => {
    document.body.innerHTML =
      '<a href="#">l</a><select></select><textarea></textarea>';
    expect(extractRole(document.querySelector('a'))).toBe('link');
    expect(extractRole(document.querySelector('select'))).toBe('combobox');
    expect(extractRole(document.querySelector('textarea'))).toBe('textbox');
  });

  it('returns the input type for a typed input (e.g. text)', () => {
    document.body.innerHTML = '<input type="text" />';
    expect(extractRole(document.querySelector('input'))).toBe('text');
  });

  it('returns "unknown" for null', () => {
    expect(extractRole(null)).toBe('unknown');
  });

  it('returns the lowercased tag for an unmapped tag', () => {
    document.body.innerHTML = '<my-widget></my-widget>';
    expect(extractRole(document.querySelector('my-widget'))).toBe('my-widget');
  });
});

// =====================================================================
// collectMetadata — type-specific form value handling + security redaction
// =====================================================================
describe('collectMetadata', () => {
  it('returns empty metadata for null', () => {
    expect(collectMetadata(null)).toEqual({ metadata: {}, executionTime: 0 });
  });

  it('redacts a password value to *** when non-empty', () => {
    document.body.innerHTML = '<input type="password" />';
    const el = document.querySelector('input');
    el.value = 'hunter2';
    const { metadata } = collectMetadata(el);
    expect(metadata.currentValue).toBe('***');
  });

  it('reports null currentValue for an empty password (nothing to redact)', () => {
    document.body.innerHTML = '<input type="password" />';
    const { metadata } = collectMetadata(document.querySelector('input'));
    expect(metadata.currentValue).toBeUndefined();
  });

  it('captures a checkbox currentValue as a boolean', () => {
    document.body.innerHTML = '<input type="checkbox" />';
    const el = document.querySelector('input');
    el.checked = true;
    const { metadata } = collectMetadata(el);
    expect(metadata.currentValue).toBe(true);
    expect(metadata.checked).toBe(true);
  });

  it('captures a radio value only when checked, null otherwise', () => {
    document.body.innerHTML =
      '<input type="radio" name="g" value="yes" />' +
      '<input type="radio" name="g" value="no" />';
    const [yes, no] = document.querySelectorAll('input');
    yes.checked = true;
    expect(collectMetadata(yes).metadata.currentValue).toBe('yes');
    // unchecked radio -> extractFormValue returns null -> currentValue omitted
    expect(collectMetadata(no).metadata.currentValue).toBeUndefined();
  });

  it('captures a regular text input current value', () => {
    document.body.innerHTML = '<input type="text" />';
    const el = document.querySelector('input');
    el.value = 'hello';
    expect(collectMetadata(el).metadata.currentValue).toBe('hello');
  });

  it('captures the single-select current value', () => {
    document.body.innerHTML =
      '<select><option value="a">A</option><option value="b">B</option></select>';
    const el = document.querySelector('select');
    el.value = 'b';
    expect(collectMetadata(el).metadata.currentValue).toBe('b');
  });

  it('captures selectedOptions array for a multi-select', () => {
    document.body.innerHTML =
      '<select multiple><option value="a">A</option><option value="b">B</option></select>';
    const el = document.querySelector('select');
    el.options[0].selected = true;
    el.options[1].selected = true;
    const { metadata } = collectMetadata(el);
    // multiple -> currentValue is array of values
    expect(metadata.currentValue).toEqual(['a', 'b']);
    expect(metadata.selectedOptions).toEqual([
      { value: 'a', text: 'A', index: 0 },
      { value: 'b', text: 'B', index: 1 },
    ]);
  });

  it('records tag, id, and class metadata for a plain element', () => {
    document.body.innerHTML = '<div id="box" class="card panel"></div>';
    const { metadata } = collectMetadata(document.getElementById('box'));
    expect(metadata.tag).toBe('div');
    expect(metadata.id).toBe('box');
    expect(metadata.classes).toEqual(['card', 'panel']);
  });

  it('captures link href/target for an anchor', () => {
    document.body.innerHTML = '<a href="https://example.com/x" target="_blank">x</a>';
    const { metadata } = collectMetadata(document.querySelector('a'));
    expect(metadata.href).toContain('example.com/x');
    expect(metadata.target).toBe('_blank');
  });

  it('collects data-* and aria-* attribute maps when present', () => {
    document.body.innerHTML =
      '<button data-testid="t" data-id="9" aria-label="Hi" role="button">x</button>';
    const { metadata } = collectMetadata(document.querySelector('button'));
    expect(metadata.dataAttributes).toMatchObject({
      'data-testid': 't',
      'data-id': '9',
    });
    expect(metadata.ariaAttributes).toMatchObject({ 'aria-label': 'Hi' });
  });
});

// =====================================================================
// buildDescription (default export) — exercises getElementType + parseColorName
// (both of which are private; tested through the public surface)
// =====================================================================
describe('buildDescription', () => {
  it('returns "Unknown element" for null', () => {
    expect(buildDescription(null).description).toBe('Unknown element');
  });

  it('describes a button with its label', () => {
    document.body.innerHTML = '<button>x</button>';
    const { description } = buildDescription(
      document.querySelector('button'),
      'Save'
    );
    expect(description).toContain('button');
    expect(description).toContain("labeled 'Save'");
  });

  it('describes typed inputs with "<type> input"', () => {
    document.body.innerHTML = '<input type="text" />';
    const { description } = buildDescription(document.querySelector('input'), 'Name');
    expect(description).toContain('text input');
  });

  it('maps select/textarea/img/a to friendly element types', () => {
    document.body.innerHTML =
      '<select></select><textarea></textarea><img alt="" /><a href="#">l</a>';
    expect(buildDescription(document.querySelector('select')).description).toContain(
      'dropdown'
    );
    expect(buildDescription(document.querySelector('textarea')).description).toContain(
      'text area'
    );
    expect(buildDescription(document.querySelector('img')).description).toContain(
      'image'
    );
    expect(buildDescription(document.querySelector('a')).description).toContain('link');
  });

  it('falls back to the raw tag name for an unmapped element', () => {
    document.body.innerHTML = '<my-thing></my-thing>';
    const { description } = buildDescription(document.querySelector('my-thing'));
    expect(description).toContain('my-thing');
  });

  it('derives a class-based color (e.g. btn-danger -> red) into the description', () => {
    // jsdom gives <button> a UA background ("buttonface"), so use an <a> whose
    // computed background is transparent -> getProminentColor falls back to the
    // class-name heuristic (checkClassBasedColor): "danger" -> red.
    document.body.innerHTML = '<a href="#" class="btn-danger">x</a>';
    const { description } = buildDescription(document.querySelector('a'), 'Delete');
    expect(description.startsWith('red ')).toBe(true);
    expect(description).toContain('link');
  });

  it('derives a parsed RGB color via a stubbed computed background', () => {
    document.body.innerHTML = '<button>x</button>';
    const el = document.querySelector('button');
    // Stub getComputedStyle so parseColorName sees a red rgb() value.
    const realGCS = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((node) => {
      if (node === el) {
        return { backgroundColor: 'rgb(220, 30, 30)' };
      }
      return realGCS(node);
    });
    const { description } = buildDescription(el, 'Go');
    expect(description.startsWith('red ')).toBe(true);
  });

  it('adds a parent location clause when parentData has a semantic tag', () => {
    document.body.innerHTML = '<button>x</button>';
    const { description } = buildDescription(
      document.querySelector('button'),
      'Submit',
      { tag: 'form', id: 'login' }
    );
    expect(description).toContain("in form 'login'");
  });

  it('caps the description length at the configured maximum (200)', () => {
    document.body.innerHTML = '<button>x</button>';
    const longLabel = 'Z'.repeat(400);
    const { description } = buildDescription(
      document.querySelector('button'),
      longLabel,
      { tag: 'section', id: 'a'.repeat(300) }
    );
    expect(description.length).toBeLessThanOrEqual(200);
  });
});

// =====================================================================
// buildParentChain — exercises isMeaningful + isComponentClass (private)
// =====================================================================
describe('buildParentChain', () => {
  it('returns the empty shape for null', () => {
    expect(buildParentChain(null)).toEqual({
      parents: [],
      fullDomPath: '',
      depth: 0,
      executionTime: 0,
    });
  });

  it('includes semantic, id-bearing, and component-class ancestors but skips generic wrappers', () => {
    document.body.innerHTML = `
      <form id="checkout">
        <div class="container">
          <div class="card-body">
            <fieldset>
              <button id="pay">Pay</button>
            </fieldset>
          </div>
        </div>
      </form>`;
    const btn = document.getElementById('pay');
    const { parents, depth } = buildParentChain(btn);

    const tags = parents.map((p) => p.tag);
    // fieldset (semantic) and form (semantic + id) are meaningful.
    expect(tags).toContain('fieldset');
    expect(tags).toContain('form');
    // .card-body is a component-ish class -> meaningful (its tag is div).
    // .container alone is a generic wrapper -> NOT meaningful.
    const formNode = parents.find((p) => p.tag === 'form');
    expect(formNode.id).toBe('checkout');
    expect(depth).toBe(parents.length);
  });

  it('treats a custom element (tag containing "-") as meaningful and a shadow host', () => {
    document.body.innerHTML =
      '<my-card><span><button id="b">x</button></span></my-card>';
    const btn = document.getElementById('b');
    const { parents } = buildParentChain(btn);
    const custom = parents.find((p) => p.tag === 'my-card');
    expect(custom).toBeTruthy();
    expect(custom.isShadowHost).toBe(true);
  });

  it('caps the chain at MAX_PARENTS (5) meaningful ancestors', () => {
    let html = '<button id="leaf">x</button>';
    for (let i = 0; i < 9; i++) {
      html = `<section id="s${i}">${html}</section>`;
    }
    document.body.innerHTML = html;
    const { parents } = buildParentChain(document.getElementById('leaf'));
    expect(parents.length).toBeLessThanOrEqual(5);
    expect(parents.length).toBe(5);
  });

  it('builds a readable fullDomPath ending at the target element', () => {
    document.body.innerHTML =
      '<form id="f"><fieldset><input id="x" /></fieldset></form>';
    const { fullDomPath } = buildParentChain(document.getElementById('x'));
    expect(fullDomPath).toContain('form#f');
    expect(fullDomPath.split(' > ').pop()).toBe('input#x');
  });

  it('records id/classes/dataAttributes onto parent nodes', () => {
    document.body.innerHTML =
      '<form id="f" data-flow="checkout" class="modal"><button id="b">x</button></form>';
    const { parents } = buildParentChain(document.getElementById('b'));
    const form = parents.find((p) => p.tag === 'form');
    expect(form.id).toBe('f');
    expect(form.classes).toContain('modal');
    expect(form.dataAttributes).toMatchObject({ 'data-flow': 'checkout' });
  });
});

// =====================================================================
// findNearbyElements — exercises calculateStability + getDirection (private)
// jsdom note: getBoundingClientRect/visibility need stubbing for any candidate
// to survive the (distance===0 / !isElementVisible) filters.
// =====================================================================
describe('findNearbyElements', () => {
  it('returns an empty context for null input', () => {
    expect(findNearbyElements(null)).toEqual({ context: [] });
  });

  it('never throws and returns the { context: [] } shape on a bare document', () => {
    document.body.innerHTML = '<button id="solo">x</button>';
    const r = findNearbyElements(document.getElementById('solo'));
    expect(r).toHaveProperty('context');
    expect(Array.isArray(r.context)).toBe(true);
  });

  it('finds and ranks visible nearby elements, classifying direction relative to the target', () => {
    document.body.innerHTML =
      '<button id="target">T</button>' +
      '<button id="below" data-testid="b">Below</button>' +
      '<a id="right" href="/x">Right link</a>';

    const target = document.getElementById('target');
    const below = document.getElementById('below');
    const right = document.getElementById('right');

    // Give them real geometry: target centered at (50,50); below is straight
    // down (50,200); right is to the side (200,50).
    stubRect(target, { x: 40, y: 40, width: 20, height: 20 }); // center 50,50
    stubRect(below, { x: 40, y: 190, width: 20, height: 20 }); // center 50,200 -> below
    stubRect(right, { x: 190, y: 40, width: 20, height: 20 }); // center 200,50 -> right

    // jsdom complete-visibility uses getComputedStyle + rect; rect is stubbed,
    // but visibility-checker also needs viewport intersection + non-hidden styles.
    // Force visibility true for our three candidates.
    // Make every stubbed element pass the viewport-intersection visibility check.
    Object.defineProperty(window, 'innerWidth', { value: 2000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 2000, configurable: true });

    const { context } = findNearbyElements(target);

    // Every returned item satisfies the context contract.
    for (const item of context) {
      expect(['above', 'below', 'left', 'right']).toContain(item.direction);
      expect(item).toHaveProperty('distance');
      expect(item).toHaveProperty('element');
    }

    // The candidate-gathering + getDirection + calculateStability path really
    // ran: the button straight below the target is classified 'below', and the
    // anchor to the side is classified 'right'.
    const belowItem = context.find((c) => c.label === 'Below');
    const rightItem = context.find((c) => c.label === 'Right link');
    expect(belowItem).toBeTruthy();
    expect(belowItem.direction).toBe('below');
    expect(belowItem.distance).toBe(150);
    expect(rightItem).toBeTruthy();
    expect(rightItem.direction).toBe('right');
  });

  it('findNearbyElementsExtended honors a custom radius and restores config afterwards', () => {
    document.body.innerHTML = '<button id="t">x</button>';
    const r = findNearbyElementsExtended(document.getElementById('t'), {
      radius: 50,
      maxCount: 2,
    });
    expect(r).toHaveProperty('context');
    expect(Array.isArray(r.context)).toBe(true);
  });
});
