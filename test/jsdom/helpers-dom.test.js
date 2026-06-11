// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  verifyNotDetached,
  isDOMReady,
  getElementPosition,
  walkUpTree,
  getComputedStyles,
  isClickable,
} from '@core/helpers/dom-utils.js';

import {
  testCss,
  countCssMatches,
  getElementByCss,
} from '@core/helpers/css-utils.js';

import {
  countXPathMatches,
  xpathPointsToElement,
} from '@core/helpers/xpath-utils.js';

import { ERROR_CODES, TrackerError } from '@core/shared/error-tracking.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// dom-utils :: verifyNotDetached
// ---------------------------------------------------------------------------
describe('dom-utils :: verifyNotDetached', () => {
  it('returns undefined (no throw) for a connected element', () => {
    document.body.innerHTML = '<div id="live"></div>';
    const el = document.getElementById('live');
    expect(el.isConnected).toBe(true);
    expect(verifyNotDetached(el, 'stage-1')).toBeUndefined();
  });

  it('throws a TrackerError with ENRICHMENT_DETACHED code for a detached element', () => {
    const el = document.createElement('div'); // never appended -> isConnected false
    expect(el.isConnected).toBe(false);
    let caught;
    try {
      verifyNotDetached(el, 'enrich');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TrackerError);
    expect(caught.code).toBe(ERROR_CODES.ENRICHMENT_DETACHED);
    expect(caught.message).toBe('Element detached at enrich');
    expect(caught.context).toEqual({ stage: 'enrich', tag: 'DIV' });
  });

  it('throws for a null element without crashing on optional chaining', () => {
    let caught;
    try {
      verifyNotDetached(null, 'null-stage');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TrackerError);
    expect(caught.code).toBe(ERROR_CODES.ENRICHMENT_DETACHED);
    expect(caught.message).toBe('Element detached at null-stage');
    // element?.tagName resolves to undefined for null
    expect(caught.context).toEqual({ stage: 'null-stage', tag: undefined });
  });

  it('throws when an element is removed from the DOM mid-flight', () => {
    document.body.innerHTML = '<span id="x"></span>';
    const el = document.getElementById('x');
    expect(verifyNotDetached(el, 'before')).toBeUndefined();
    el.remove();
    expect(() => verifyNotDetached(el, 'after')).toThrow(TrackerError);
  });
});

// ---------------------------------------------------------------------------
// dom-utils :: isDOMReady
// ---------------------------------------------------------------------------
describe('dom-utils :: isDOMReady', () => {
  it('returns true for the live document (readyState complete/interactive + body)', () => {
    // jsdom default document is "complete" with a body
    expect(['complete', 'interactive']).toContain(document.readyState);
    expect(isDOMReady(document)).toBe(true);
  });

  it('returns false for a document in the loading state', () => {
    const fakeDoc = { nodeType: 9, readyState: 'loading', body: document.body };
    expect(isDOMReady(fakeDoc)).toBe(false);
  });

  it('returns true for an interactive document that has no body but a populated documentElement', () => {
    const fakeDoc = {
      nodeType: 9,
      readyState: 'interactive',
      body: null,
      documentElement: { childNodes: { length: 3 } },
    };
    expect(isDOMReady(fakeDoc)).toBe(true);
  });

  it('returns false for an interactive document with no body and an empty documentElement', () => {
    const fakeDoc = {
      nodeType: 9,
      readyState: 'interactive',
      body: null,
      documentElement: { childNodes: { length: 0 } },
    };
    expect(isDOMReady(fakeDoc)).toBe(false);
  });

  it('returns true for an iframe whose contentDocument is ready', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    // jsdom gives same-origin iframes a real complete document with a body
    const inner = iframe.contentDocument;
    expect(inner).toBeTruthy();
    expect(isDOMReady(iframe)).toBe(true);
  });

  it('returns false for an iframe whose contentDocument access throws (cross-origin)', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      get() {
        throw new Error('SecurityError: cross-origin');
      },
    });
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get() {
        throw new Error('SecurityError: cross-origin');
      },
    });
    expect(isDOMReady(iframe)).toBe(false);
  });

  it('returns false for an iframe whose contentDocument is null', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    Object.defineProperty(iframe, 'contentDocument', {
      configurable: true,
      get() {
        return null;
      },
    });
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      get() {
        return undefined;
      },
    });
    expect(isDOMReady(iframe)).toBe(false);
  });

  it('returns false for non-Document / non-iframe inputs', () => {
    expect(isDOMReady(document.createElement('div'))).toBe(false);
    expect(isDOMReady(null)).toBe(false);
    expect(isDOMReady(undefined)).toBe(false);
    expect(isDOMReady('http://example.com')).toBe(false);
    expect(isDOMReady(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// dom-utils :: getElementPosition
//   jsdom has no layout engine: getBoundingClientRect returns zeros, so we
//   stub it to exercise the scroll-offset arithmetic.
// ---------------------------------------------------------------------------
describe('dom-utils :: getElementPosition', () => {
  it('returns all-zero coordinate object for a null/invalid element', () => {
    expect(getElementPosition(null)).toEqual({
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
    });
    // object without getBoundingClientRect also short-circuits
    expect(getElementPosition({})).toEqual({
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
    });
  });

  it('adds page scroll offset to the bounding rect coordinates', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50,
    });
    // Default jsdom offsets are 0; override with non-zero scroll.
    Object.defineProperty(window, 'pageXOffset', { configurable: true, value: 5 });
    Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 7 });

    const pos = getElementPosition(el);
    expect(pos).toEqual({
      x: 15,        // left(10) + scrollLeft(5)
      y: 27,        // top(20) + scrollTop(7)
      width: 100,
      height: 50,
      top: 27,      // top(20) + scrollTop(7)
      left: 15,     // left(10) + scrollLeft(5)
      right: 115,   // right(110) + scrollLeft(5)
      bottom: 77,   // bottom(70) + scrollTop(7)
    });
  });

  it('handles a zero-dimension rect with no scroll offset', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0,
    });
    Object.defineProperty(window, 'pageXOffset', { configurable: true, value: 0 });
    Object.defineProperty(window, 'pageYOffset', { configurable: true, value: 0 });
    expect(getElementPosition(el)).toEqual({
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// dom-utils :: walkUpTree
// ---------------------------------------------------------------------------
describe('dom-utils :: walkUpTree', () => {
  it('returns ancestors in order (immediate parent first) up to default depth', () => {
    document.body.innerHTML =
      '<div id="g"><div id="p"><div id="c"><span id="t"></span></div></div></div>';
    const target = document.getElementById('t');
    const parents = walkUpTree(target);
    // c, p, g, body, html (5 ancestors, well under default maxDepth 7)
    expect(parents[0].id).toBe('c');
    expect(parents[1].id).toBe('p');
    expect(parents[2].id).toBe('g');
    expect(parents[3]).toBe(document.body);
    expect(parents[4]).toBe(document.documentElement);
    expect(parents.length).toBe(5);
  });

  it('respects maxDepth=1, returning only the immediate parent', () => {
    document.body.innerHTML = '<div id="p"><span id="t"></span></div>';
    const target = document.getElementById('t');
    const parents = walkUpTree(target, 1);
    expect(parents.length).toBe(1);
    expect(parents[0].id).toBe('p');
  });

  it('returns [] for maxDepth=0', () => {
    document.body.innerHTML = '<div id="p"><span id="t"></span></div>';
    const target = document.getElementById('t');
    expect(walkUpTree(target, 0)).toEqual([]);
  });

  it('returns [] for a null element', () => {
    expect(walkUpTree(null)).toEqual([]);
    expect(walkUpTree(undefined)).toEqual([]);
  });

  it('returns [] for an element with no parent (documentElement)', () => {
    // documentElement's parentElement is null
    expect(walkUpTree(document.documentElement)).toEqual([]);
  });

  it('stops at maxDepth even when more ancestors exist', () => {
    document.body.innerHTML =
      '<div id="a"><div id="b"><div id="c"><div id="d"><span id="t"></span></div></div></div></div>';
    const target = document.getElementById('t');
    const parents = walkUpTree(target, 2);
    expect(parents.length).toBe(2);
    expect(parents[0].id).toBe('d');
    expect(parents[1].id).toBe('c');
  });
});

// ---------------------------------------------------------------------------
// dom-utils :: getComputedStyles
// ---------------------------------------------------------------------------
describe('dom-utils :: getComputedStyles', () => {
  it('returns {} for a null element', () => {
    expect(getComputedStyles(null)).toEqual({});
  });

  it('returns the requested explicit properties from getComputedStyle', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      backgroundColor: 'rgb(255, 0, 0)',
      color: 'rgb(0, 0, 0)',
    });
    const styles = getComputedStyles(el, ['backgroundColor', 'color']);
    expect(styles).toEqual({
      backgroundColor: 'rgb(255, 0, 0)',
      color: 'rgb(0, 0, 0)',
    });
  });

  it('uses the default property set when properties array is empty', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const fakeStyle = {
      backgroundColor: 'bg',
      color: 'c',
      fontSize: 'fs',
      fontFamily: 'ff',
      fontWeight: 'fw',
      display: 'block',
    };
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(fakeStyle);
    const styles = getComputedStyles(el);
    expect(Object.keys(styles).sort()).toEqual(
      ['backgroundColor', 'color', 'display', 'fontFamily', 'fontSize', 'fontWeight'].sort()
    );
    expect(styles.display).toBe('block');
  });

  it('skips properties whose access throws (getter throws) without crashing', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const trapStyle = {};
    Object.defineProperty(trapStyle, 'color', {
      enumerable: true,
      get() {
        return 'rgb(1, 2, 3)';
      },
    });
    Object.defineProperty(trapStyle, 'backgroundColor', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(trapStyle);
    const styles = getComputedStyles(el, ['backgroundColor', 'color']);
    // backgroundColor access threw and was skipped; color survived.
    expect(styles).toEqual({ color: 'rgb(1, 2, 3)' });
  });

  it('returns undefined values for non-existent CSS properties (no crash)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({});
    const styles = getComputedStyles(el, ['nonExistentProp']);
    expect(styles).toHaveProperty('nonExistentProp', undefined);
  });
});

// ---------------------------------------------------------------------------
// dom-utils :: isClickable
//   cursor branch requires stubbing getComputedStyle (jsdom returns '' for cursor)
// ---------------------------------------------------------------------------
describe('dom-utils :: isClickable', () => {
  beforeEach(() => {
    // Neutral default so tag/role/onclick branches are tested in isolation.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ cursor: 'auto' });
  });

  it('returns true for an <a> tag', () => {
    const a = document.createElement('a');
    expect(isClickable(a)).toBe(true);
  });

  it('returns true for a <button> tag', () => {
    const b = document.createElement('button');
    expect(isClickable(b)).toBe(true);
  });

  it('returns true for an element with an onclick attribute', () => {
    const div = document.createElement('div');
    div.setAttribute('onclick', 'doThing()');
    expect(isClickable(div)).toBe(true);
  });

  it('returns true for an element with an onclick handler property', () => {
    const div = document.createElement('div');
    div.onclick = () => {};
    expect(isClickable(div)).toBe(true);
  });

  it('returns true for role="button" and role="link"', () => {
    const a = document.createElement('div');
    a.setAttribute('role', 'button');
    const b = document.createElement('div');
    b.setAttribute('role', 'link');
    expect(isClickable(a)).toBe(true);
    expect(isClickable(b)).toBe(true);
  });

  it('returns true when computed cursor is pointer', () => {
    window.getComputedStyle.mockReturnValue({ cursor: 'pointer' });
    const div = document.createElement('div');
    expect(isClickable(div)).toBe(true);
  });

  it('returns false for a plain <div> with no interactive signals', () => {
    const div = document.createElement('div');
    expect(isClickable(div)).toBe(false);
  });

  it('returns false for a custom role like role="presentation"', () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'presentation');
    expect(isClickable(div)).toBe(false);
  });

  it('returns false for a null element', () => {
    expect(isClickable(null)).toBe(false);
  });

  it('matches tag names case-insensitively (created lowercase, tagName is upper)', () => {
    // createElement('button') yields tagName 'BUTTON'; isClickable upper-cases.
    const b = document.createElement('button');
    expect(b.tagName).toBe('BUTTON');
    expect(isClickable(b)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// css-utils :: testCss
// ---------------------------------------------------------------------------
describe('css-utils :: testCss', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="foo" id="only"></div>' +
      '<div class="bar"></div>' +
      '<div class="bar"></div>';
  });

  it('reports a valid unique selector (#only)', () => {
    const r = testCss('#only');
    expect(r).toEqual({ valid: true, count: 1, unique: true, error: null });
  });

  it('reports a valid selector matching 2+ elements as non-unique', () => {
    const r = testCss('.bar');
    expect(r.valid).toBe(true);
    expect(r.count).toBe(2);
    expect(r.unique).toBe(false);
    expect(r.error).toBeNull();
  });

  it('reports a valid selector with zero matches (count 0, not unique)', () => {
    const r = testCss('.does-not-exist');
    expect(r).toEqual({ valid: true, count: 0, unique: false, error: null });
  });

  it('reports an invalid selector with valid:false and an error message', () => {
    const r = testCss('div:::bogus');
    expect(r.valid).toBe(false);
    expect(r.count).toBe(0);
    expect(r.unique).toBe(false);
    expect(typeof r.error).toBe('string');
    expect(r.error.length).toBeGreaterThan(0);
  });

  it('works against a custom (non-document) context element', () => {
    const scope = document.createElement('div');
    scope.innerHTML = '<span class="x"></span><span class="x"></span>';
    const r = testCss('.x', scope);
    expect(r.valid).toBe(true);
    expect(r.count).toBe(2);
    expect(r.unique).toBe(false);
  });

  it('treats an empty selector as invalid', () => {
    const r = testCss('');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// css-utils :: countCssMatches
// ---------------------------------------------------------------------------
describe('css-utils :: countCssMatches', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<p class="m"></p><p class="m"></p><p class="m"></p>';
  });

  it('returns the number of matching elements', () => {
    expect(countCssMatches('.m')).toBe(3);
  });

  it('returns 0 for a valid selector with no matches', () => {
    expect(countCssMatches('.none')).toBe(0);
  });

  it('returns 0 (not -1, not throw) for an invalid selector', () => {
    expect(countCssMatches('p:::nope')).toBe(0);
  });

  it('counts within a custom context', () => {
    const scope = document.createElement('section');
    scope.innerHTML = '<a class="k"></a>';
    expect(countCssMatches('.k', scope)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// css-utils :: getElementByCss
// ---------------------------------------------------------------------------
describe('css-utils :: getElementByCss', () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="go" class="cta">Go</button>';
  });

  it('returns the first matching element', () => {
    const el = getElementByCss('#go');
    expect(el).toBe(document.getElementById('go'));
  });

  it('returns null when no element matches', () => {
    expect(getElementByCss('.missing')).toBeNull();
  });

  it('returns null (no throw) for an invalid selector', () => {
    expect(getElementByCss('button:::broken')).toBeNull();
  });

  it('queries within a custom context', () => {
    const scope = document.createElement('div');
    const inner = document.createElement('em');
    inner.className = 'z';
    scope.appendChild(inner);
    expect(getElementByCss('.z', scope)).toBe(inner);
  });
});

// ---------------------------------------------------------------------------
// xpath-utils :: countXPathMatches
//   jsdom supports document.evaluate / XPathResult.
// ---------------------------------------------------------------------------
describe('xpath-utils :: countXPathMatches', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<ul><li class="i"></li><li class="i"></li><li class="i"></li></ul>';
  });

  it('returns the number of matching nodes for a valid XPath', () => {
    expect(countXPathMatches('//li')).toBe(3);
  });

  it('returns 0 for a valid XPath with no matches', () => {
    expect(countXPathMatches('//table')).toBe(0);
  });

  it('returns -1 for an invalid XPath expression (distinct from zero matches)', () => {
    expect(countXPathMatches('//[[bogus')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// xpath-utils :: xpathPointsToElement
//   getEvaluationContext(element) returns document for light-DOM elements.
// ---------------------------------------------------------------------------
describe('xpath-utils :: xpathPointsToElement', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="wrap"><button id="target">Click</button><button id="other">Other</button></div>';
  });

  it('returns true when the XPath resolves to the target element', () => {
    const target = document.getElementById('target');
    expect(xpathPointsToElement("//button[@id='target']", target)).toBe(true);
  });

  it('returns false when the XPath resolves to a different element', () => {
    const target = document.getElementById('target');
    expect(xpathPointsToElement("//button[@id='other']", target)).toBe(false);
  });

  it('returns false when the XPath matches nothing', () => {
    const target = document.getElementById('target');
    expect(xpathPointsToElement("//button[@id='ghost']", target)).toBe(false);
  });

  it('returns false for an invalid XPath without throwing', () => {
    const target = document.getElementById('target');
    expect(xpathPointsToElement('//[[bogus', target)).toBe(false);
  });

  it('honors an explicit context argument when provided', () => {
    const target = document.getElementById('target');
    // Passing document explicitly bypasses getEvaluationContext.
    expect(xpathPointsToElement("//button[@id='target']", target, document)).toBe(true);
  });
});
