// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import {
  isElementTrulyVisible,
  isElementInteractable,
} from '@core/helpers/visibility-checker.js';
import ShadowDOMTraverser from '@core/helpers/shadow-dom-traverser.js';
import { stripHtml } from '@core/helpers/text-utils.js';

// ---------------------------------------------------------------------------
// jsdom has NO layout engine: getBoundingClientRect() returns an all-zero rect
// and getComputedStyle() reports only explicitly-set inline styles (not the
// browser's resolved defaults — e.g. opacity defaults to '' not '1'). Every
// visibility test therefore stubs getBoundingClientRect on the element and, in
// most cases, getComputedStyle on window, so we exercise the real branching
// logic in visibility-checker.js rather than jsdom's degenerate layout values.
// ---------------------------------------------------------------------------

// A sensible default viewport for jsdom (matches jsdom defaults: 1024x768).
const VIEWPORT = { innerWidth: 1024, innerHeight: 768 };

// Build a rect from a partial spec; an element is "visible-sized & on screen"
// by default.
function makeRect(over = {}) {
  const base = {
    top: 10,
    left: 10,
    right: 110,
    bottom: 60,
    width: 100,
    height: 50,
    x: 10,
    y: 10,
  };
  return { ...base, ...over };
}

// Force a given rect on an element.
function stubRect(el, rect) {
  el.getBoundingClientRect = () => rect;
}

// Stub window.getComputedStyle to return the provided style object for `el`,
// and a fully-visible style object for everyone else (so parent checks pass).
function stubStyles(elToStyle) {
  const visibleDefault = {
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    overflow: 'visible',
    clipPath: 'none',
    clip: 'auto',
    pointerEvents: 'auto',
    cursor: 'auto',
  };
  vi.spyOn(window, 'getComputedStyle').mockImplementation((node) => {
    const found = elToStyle.get(node);
    return { ...visibleDefault, ...(found || {}) };
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.innerWidth = VIEWPORT.innerWidth;
  window.innerHeight = VIEWPORT.innerHeight;
  // Static caches in the traverser leak across files/tests — reset them.
  ShadowDOMTraverser.clearCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  // The module starts a 30s setInterval on import (startPeriodicCleanup).
  // Stop it so vitest can exit cleanly and the timer doesn't leak.
  ShadowDOMTraverser.stopPeriodicCleanup();
});

// ===========================================================================
// visibility-checker.js :: isElementTrulyVisible
// ===========================================================================
describe('isElementTrulyVisible', () => {
  it('returns false for null / undefined / non-element input', () => {
    expect(isElementTrulyVisible(null)).toBe(false);
    expect(isElementTrulyVisible(undefined)).toBe(false);
    // object without getBoundingClientRect
    expect(isElementTrulyVisible({})).toBe(false);
    expect(isElementTrulyVisible('not-an-element')).toBe(false);
  });

  it('complete mode: returns true for a properly sized, on-screen, visible element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { display: 'block', visibility: 'visible', opacity: '1' }]]));
    expect(isElementTrulyVisible(el)).toBe(true);
  });

  it('returns false when display:none', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { display: 'none' }]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('returns false when visibility:hidden', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { visibility: 'hidden' }]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('returns false when opacity is below MIN_OPACITY (0.1)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { opacity: '0.05' }]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('opacity exactly 0.1 is the inclusive lower bound (visible)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { opacity: '0.1' }]]));
    // hasValidStyles only rejects opacity < 0.1, so 0.1 passes.
    expect(isElementTrulyVisible(el)).toBe(true);
  });

  it('returns false when width/height below MIN_DIMENSION (1px)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect({ width: 0.5, height: 0.5 }));
    stubStyles(new Map([[el, {}]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('dimension exactly 1px is the inclusive lower bound (passes the size check)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect({ width: 1, height: 1, right: 11, bottom: 11 }));
    stubStyles(new Map([[el, {}]]));
    expect(isElementTrulyVisible(el)).toBe(true);
  });

  it('returns false when element is entirely off-screen (above viewport)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    // bottom <= 0 => not intersecting viewport vertically
    stubRect(el, makeRect({ top: -100, bottom: -50, height: 50 }));
    stubStyles(new Map([[el, {}]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('returns false when element is entirely off-screen (below viewport)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect({ top: 900, bottom: 950 })); // top >= innerHeight(768)
    stubStyles(new Map([[el, {}]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('returns false when element is entirely off-screen (left of viewport)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect({ left: -200, right: -10 })); // right <= 0
    stubStyles(new Map([[el, {}]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('complete mode: returns false when a parent has display:none', () => {
    const parent = document.createElement('div');
    const el = document.createElement('div');
    parent.appendChild(el);
    document.body.appendChild(parent);
    stubRect(el, makeRect());
    stubRect(parent, makeRect());
    stubStyles(
      new Map([
        [el, { display: 'block', visibility: 'visible', opacity: '1' }],
        [parent, { display: 'none' }],
      ])
    );
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('complete mode: returns false when a parent has opacity below threshold', () => {
    const parent = document.createElement('div');
    const el = document.createElement('div');
    parent.appendChild(el);
    document.body.appendChild(parent);
    stubRect(el, makeRect());
    stubRect(parent, makeRect());
    stubStyles(
      new Map([
        [el, {}],
        [parent, { opacity: '0' }],
      ])
    );
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('complete mode: parent with overflow:hidden that does NOT clip child stays visible', () => {
    const parent = document.createElement('div');
    const el = document.createElement('div');
    parent.appendChild(el);
    document.body.appendChild(parent);
    // child fully inside parent's rect
    stubRect(el, makeRect({ top: 20, left: 20, right: 80, bottom: 50 }));
    stubRect(parent, makeRect({ top: 0, left: 0, right: 200, bottom: 200 }));
    stubStyles(
      new Map([
        [el, {}],
        [parent, { overflow: 'hidden' }],
      ])
    );
    expect(isElementTrulyVisible(el)).toBe(true);
  });

  it('complete mode: parent with overflow:hidden that clips child off returns false', () => {
    const parent = document.createElement('div');
    const el = document.createElement('div');
    parent.appendChild(el);
    document.body.appendChild(parent);
    // child entirely below the parent's bottom edge => clipped away
    stubRect(el, makeRect({ top: 300, bottom: 350 }));
    stubRect(parent, makeRect({ top: 0, left: 0, right: 200, bottom: 100 }));
    stubStyles(
      new Map([
        [el, {}],
        [parent, { overflow: 'hidden' }],
      ])
    );
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('complete mode: clip-path inset(100%) marks element hidden', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { clipPath: 'inset(100%)' }]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('complete mode: legacy clip: rect(0,...) marks element hidden', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { clip: 'rect(0, 0, 0, 0)' }]]));
    expect(isElementTrulyVisible(el)).toBe(false);
  });

  it('fast mode skips parent traversal: hidden parent does NOT hide the child', () => {
    const parent = document.createElement('div');
    const el = document.createElement('div');
    parent.appendChild(el);
    document.body.appendChild(parent);
    stubRect(el, makeRect());
    // parent rect not even needed in fast mode
    stubStyles(
      new Map([
        [el, { display: 'block', visibility: 'visible', opacity: '1' }],
        [parent, { display: 'none' }],
      ])
    );
    // complete mode would be false; fast mode ignores the parent.
    expect(isElementTrulyVisible(el, 'fast')).toBe(true);
    expect(isElementTrulyVisible(el, 'complete')).toBe(false);
  });

  it('fast mode uses strict in-viewport intersection (still false when off-screen)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect({ top: 900, bottom: 950 }));
    stubStyles(new Map([[el, {}]]));
    expect(isElementTrulyVisible(el, 'fast')).toBe(false);
  });

  it('swallows errors thrown by getComputedStyle and returns false', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(isElementTrulyVisible(el)).toBe(false);
  });
});

// ===========================================================================
// visibility-checker.js :: isElementInteractable
// ===========================================================================
describe('isElementInteractable', () => {
  // Helper: make a fully-visible element of a given tag with given styles.
  function visible(tag, styleOver = {}, attrs = {}) {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    stubRect(el, makeRect());
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return { el, styleOver };
  }

  it('returns false when the element is not visible (even if interactive)', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, makeRect({ width: 0, height: 0 }));
    stubStyles(new Map([[el, {}]]));
    expect(isElementInteractable(el)).toBe(false);
  });

  it('returns true for a visible BUTTON', () => {
    const { el } = visible('button');
    stubStyles(new Map([[el, {}]]));
    expect(isElementInteractable(el)).toBe(true);
  });

  it('returns true for a visible anchor / input / select / textarea / label', () => {
    for (const tag of ['a', 'input', 'select', 'textarea', 'label']) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      stubRect(el, makeRect());
      stubStyles(new Map([[el, {}]]));
      expect(isElementInteractable(el)).toBe(true);
    }
  });

  it('returns true for a visible element carrying an onclick attribute', () => {
    const el = document.createElement('div');
    el.setAttribute('onclick', 'doThing()');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, {}]]));
    expect(isElementInteractable(el)).toBe(true);
  });

  it('returns true for a visible element with tabIndex >= 0', () => {
    const el = document.createElement('div');
    el.setAttribute('tabindex', '0');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, {}]]));
    expect(isElementInteractable(el)).toBe(true);
  });

  it('returns true for role="button" and is case-insensitive (role="BUTTON")', () => {
    const lower = document.createElement('div');
    lower.setAttribute('role', 'button');
    const upper = document.createElement('div');
    upper.setAttribute('role', 'BUTTON');
    document.body.append(lower, upper);
    stubRect(lower, makeRect());
    stubRect(upper, makeRect());
    stubStyles(
      new Map([
        [lower, {}],
        [upper, {}],
      ])
    );
    expect(isElementInteractable(lower)).toBe(true);
    expect(isElementInteractable(upper)).toBe(true);
  });

  it('returns true for a visible div with cursor:pointer', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { cursor: 'pointer' }]]));
    expect(isElementInteractable(el)).toBe(true);
  });

  it('returns false for a plain visible div with no interactive signal', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { cursor: 'auto' }]]));
    expect(isElementInteractable(el)).toBe(false);
  });

  it('returns false when pointer-events:none, even on a visible BUTTON', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    stubRect(el, makeRect());
    stubStyles(new Map([[el, { pointerEvents: 'none' }]]));
    expect(isElementInteractable(el)).toBe(false);
  });
});

// ===========================================================================
// shadow-dom-traverser.js :: getShadowPath
// ===========================================================================
describe('ShadowDOMTraverser.getShadowPath', () => {
  it('element in light DOM returns inShadowDOM:false, depth 0, framework "none"', () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    const path = ShadowDOMTraverser.getShadowPath(el);
    expect(path.inShadowDOM).toBe(false);
    expect(path.hosts).toEqual([]);
    expect(path.depth).toBe(0);
    expect(path.framework).toBe('none');
    expect(path.isLightning).toBe(false);
    expect(path.isAura).toBe(false);
  });

  it('element inside an open shadow root reports a single host with mode/tag/id', () => {
    const host = document.createElement('my-widget');
    host.id = 'widget-1';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    root.appendChild(inner);

    const path = ShadowDOMTraverser.getShadowPath(inner);
    expect(path.inShadowDOM).toBe(true);
    expect(path.depth).toBe(1);
    expect(path.hosts).toHaveLength(1);
    const [h] = path.hosts;
    expect(h.hostTag).toBe('my-widget');
    expect(h.mode).toBe('open');
    expect(h.hostId).toBe('widget-1');
    expect(h.host).toBe(host);
  });

  it('nested shadow roots report hosts outermost-first with depth 2', () => {
    const outer = document.createElement('outer-host');
    document.body.appendChild(outer);
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('inner-host');
    outerRoot.appendChild(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    const target = document.createElement('span');
    innerRoot.appendChild(target);

    const path = ShadowDOMTraverser.getShadowPath(target);
    expect(path.depth).toBe(2);
    expect(path.hosts.map((h) => h.hostTag)).toEqual(['outer-host', 'inner-host']);
  });

  it('detects Lightning Web Components from a "lightning-" host tag', () => {
    const host = document.createElement('lightning-button');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('button');
    root.appendChild(inner);

    const path = ShadowDOMTraverser.getShadowPath(inner);
    expect(path.isLightning).toBe(true);
    expect(path.framework).toBe('lightning');
  });

  it('detects LWC namespaced "c-" host tags as lightning', () => {
    const host = document.createElement('c-my-cmp');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    root.appendChild(inner);

    const path = ShadowDOMTraverser.getShadowPath(inner);
    expect(path.isLightning).toBe(true);
    expect(path.framework).toBe('lightning');
  });

  it('detects Aura via data-aura-rendered-by host attribute', () => {
    const host = document.createElement('aura-host');
    host.setAttribute('data-aura-rendered-by', '123:0');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    root.appendChild(inner);

    const path = ShadowDOMTraverser.getShadowPath(inner);
    expect(path.isAura).toBe(true);
    expect(path.framework).toBe('aura');
  });

  it('classifies generic web-component frameworks (ionic) by tag prefix', () => {
    const host = document.createElement('ion-button');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.appendChild(document.createElement('span'));
    const path = ShadowDOMTraverser.getShadowPath(root.firstChild);
    expect(path.framework).toBe('ionic');
  });

  it('extracts whitelisted host attributes into hostAttributes', () => {
    const host = document.createElement('my-cmp');
    host.setAttribute('data-testid', 'submit-btn');
    host.setAttribute('aria-label', 'Submit');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.appendChild(document.createElement('span'));

    const path = ShadowDOMTraverser.getShadowPath(root.firstChild);
    expect(path.hosts[0].hostAttributes['data-testid']).toBe('submit-btn');
    expect(path.hosts[0].hostAttributes['aria-label']).toBe('Submit');
  });
});

// ===========================================================================
// shadow-dom-traverser.js :: findAllElements
// ===========================================================================
describe('ShadowDOMTraverser.findAllElements', () => {
  it('finds matches in the light DOM', () => {
    document.body.innerHTML = '<button class="x">a</button><button class="x">b</button>';
    const found = ShadowDOMTraverser.findAllElements(document, 'button.x');
    expect(found).toHaveLength(2);
    expect(found.every((e) => e.tagName === 'BUTTON')).toBe(true);
  });

  it('pierces an open shadow boundary to find matching elements', () => {
    const host = document.createElement('my-host');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const innerBtn = document.createElement('button');
    innerBtn.className = 'deep';
    root.appendChild(innerBtn);

    const found = ShadowDOMTraverser.findAllElements(document, 'button.deep');
    expect(found).toContain(innerBtn);
  });

  it('returns a de-duplicated array (no element appears twice)', () => {
    const host = document.createElement('my-host');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.className = 'target';
    root.appendChild(inner);

    const found = ShadowDOMTraverser.findAllElements(document, '.target');
    const unique = new Set(found);
    expect(unique.size).toBe(found.length);
  });

  it('maxDepth=1 stops before descending into a nested (2nd-level) shadow root', () => {
    const outer = document.createElement('outer-host');
    document.body.appendChild(outer);
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('inner-host');
    outerRoot.appendChild(inner);
    const innerRoot = inner.attachShadow({ mode: 'open' });
    const deep = document.createElement('button');
    deep.className = 'deep';
    innerRoot.appendChild(deep);

    // depth 0 = document, depth 1 = outerRoot. With maxDepth=1, the innerRoot
    // (depth 2) is never traversed, so the deep button is not found.
    const found = ShadowDOMTraverser.findAllElements(document, 'button.deep', 1);
    expect(found).not.toContain(deep);

    // sanity: with default depth it IS found
    ShadowDOMTraverser.clearCache();
    const foundDeep = ShadowDOMTraverser.findAllElements(document, 'button.deep', 10);
    expect(foundDeep).toContain(deep);
  });

  it('maxDepth=0 still queries the root level but descends no further', () => {
    document.body.innerHTML = '<button class="top">x</button>';
    const host = document.createElement('my-host');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const innerBtn = document.createElement('button');
    innerBtn.className = 'top';
    root.appendChild(innerBtn);

    const found = ShadowDOMTraverser.findAllElements(document, 'button.top', 0);
    // root-level button found, shadow one not (depth+1 > 0 stops it)
    expect(found.length).toBe(1);
    expect(found[0]).not.toBe(innerBtn);
  });

  it('invalid selector is swallowed; traversal returns an empty array, not a throw', () => {
    document.body.innerHTML = '<div>x</div>';
    let result;
    expect(() => {
      result = ShadowDOMTraverser.findAllElements(document, ':::not-a-valid-selector');
    }).not.toThrow();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('does not loop forever on circular shadow structures (visited set)', () => {
    // Build a host whose shadow root contains a reference back to an ancestor
    // host. The traverser tracks visited roots via a WeakSet; a child element
    // that re-exposes the same shadowRoot must not cause infinite recursion.
    const host = document.createElement('my-host');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const child = document.createElement('div');
    child.className = 'circ';
    root.appendChild(child);
    // Make child appear to host the SAME shadow root (circular reference).
    Object.defineProperty(child, 'shadowRoot', { value: root, configurable: true });

    let found;
    expect(() => {
      found = ShadowDOMTraverser.findAllElements(document, '.circ');
    }).not.toThrow();
    expect(found).toContain(child);
  });

  it('returns [] when root has no querySelectorAll', () => {
    const found = ShadowDOMTraverser.findAllElements({}, 'div');
    expect(found).toEqual([]);
  });
});

// ===========================================================================
// shadow-dom-traverser.js :: getCachedElements / LRU cache
// ===========================================================================
describe('ShadowDOMTraverser.getCachedElements (LRU + TTL)', () => {
  it('cache miss returns null', () => {
    const host = document.createElement('my-host');
    host.id = 'miss';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    expect(ShadowDOMTraverser.getCachedElements(root)).toBeNull();
  });

  it('returns the cached element list within the TTL window', () => {
    const host = document.createElement('my-host');
    host.id = 'hit';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const els = [document.createElement('span')];

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    ShadowDOMTraverser.setCachedElements(root, els);
    nowSpy.mockReturnValue(1000 + 4999); // < cacheExpiry (5000)
    expect(ShadowDOMTraverser.getCachedElements(root)).toBe(els);
  });

  it('deletes and returns null for an entry past the TTL', () => {
    const host = document.createElement('my-host');
    host.id = 'expired';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const els = [document.createElement('span')];

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    ShadowDOMTraverser.setCachedElements(root, els);
    nowSpy.mockReturnValue(1000 + 5001); // > cacheExpiry (5000)
    expect(ShadowDOMTraverser.getCachedElements(root)).toBeNull();
    // confirm the stale key was actually evicted
    nowSpy.mockReturnValue(20000);
    expect(ShadowDOMTraverser.getCachedElements(root)).toBeNull();
  });

  it('a cache hit moves the key to the most-recently-used end of the LRU order', () => {
    const mk = (id) => {
      const host = document.createElement('my-host');
      host.id = id;
      document.body.appendChild(host);
      return host.attachShadow({ mode: 'open' });
    };
    const a = mk('a');
    const b = mk('b');
    ShadowDOMTraverser.setCachedElements(a, [1]);
    ShadowDOMTraverser.setCachedElements(b, [2]);
    // order is now [a, b]; touch a so it becomes most-recent => [b, a]
    ShadowDOMTraverser.getCachedElements(a);
    expect(ShadowDOMTraverser.cacheAccessOrder.slice(-1)[0]).toBe('my-host:a:');
  });

  it('clearCache() empties the cache Map and access-order array', () => {
    const host = document.createElement('my-host');
    host.id = 'c';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    ShadowDOMTraverser.setCachedElements(root, [1]);
    expect(ShadowDOMTraverser.shadowRootCache.size).toBeGreaterThan(0);

    const ret = ShadowDOMTraverser.clearCache();
    expect(ret).toBeUndefined();
    expect(ShadowDOMTraverser.shadowRootCache.size).toBe(0);
    expect(ShadowDOMTraverser.cacheAccessOrder).toEqual([]);
  });

  it('builds a stable key of the form "tag:id:data-key" from the host', () => {
    const host = document.createElement('my-host');
    host.id = 'h1';
    host.setAttribute('data-key', 'k1');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    expect(ShadowDOMTraverser.getShadowRootKey(root)).toBe('my-host:h1:k1');
  });
});

// ===========================================================================
// text-utils.js :: stripHtml
// ===========================================================================
describe('stripHtml', () => {
  it('extracts plain text from a simple element', () => {
    expect(stripHtml('<p>hello</p>')).toBe('hello');
  });

  it('extracts and concatenates text across nested tags', () => {
    expect(stripHtml('<div><span>foo</span> <b>bar</b></div>')).toBe('foo bar');
  });

  it('returns plain text unchanged when there is no markup', () => {
    expect(stripHtml('just text')).toBe('just text');
  });

  it('returns empty string for non-string input', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
    expect(stripHtml(123)).toBe('');
    expect(stripHtml({})).toBe('');
    expect(stripHtml(['<p>x</p>'])).toBe('');
  });

  it('returns empty string for empty input and tag-only input', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml('<br><hr>')).toBe('');
  });

  it('does NOT execute script content but extracts its text node (innerHTML assigns inertly)', () => {
    // Assigning innerHTML to a detached div does not run scripts, but the text
    // node inside <script> becomes textContent. We assert no execution + the
    // raw script source comes through as text.
    const out = stripHtml('<div>visible</div><script>window.__pwn = 1;</script>');
    expect(window.__pwn).toBeUndefined();
    expect(out).toContain('visible');
  });

  it('decodes HTML entities to their character form', () => {
    expect(stripHtml('a &amp; b &lt;c&gt;')).toBe('a & b <c>');
  });
});
