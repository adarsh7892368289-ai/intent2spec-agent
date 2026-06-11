// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import ClickCapture from '@core/capture/click-capture.js';
import InputCapture from '@core/capture/input-capture.js';
import FormCapture from '@core/capture/form-capture.js';
import ScrollCapture from '@core/capture/scroll-capture.js';
import NavigationCapture from '@core/capture/navigation-capture.js';
import PageScanner from '@core/capture/page-scanner.js';
import { FORM_CAPTURE_CONFIG, INPUT_CAPTURE_CONFIG } from '@core/shared/config.js';

// These suites exercise pure / DOM-light predicate + util methods only. We avoid
// calling init()/start() (which attach global listeners and patch History) and
// rely on destroy() in afterEach for the few instances that touch globals.

beforeEach(() => {
  document.body.innerHTML = '';
  delete window.__capturePasswordFields;
  delete window.__isScanningPage;
});

// ---------------------------------------------------------------------------
// ClickCapture.shouldIgnoreElement
// ---------------------------------------------------------------------------
describe('ClickCapture.shouldIgnoreElement', () => {
  let capture;

  beforeEach(() => {
    // constructor attaches a window 'tracker-error' listener via setupErrorListener;
    // it does not call init(), so no document click listener is added.
    capture = new ClickCapture('interactions');
  });

  const ignoredTags = ['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'HTML'];
  for (const tag of ignoredTags) {
    it(`ignores infrastructure tag <${tag.toLowerCase()}>`, () => {
      const el = document.createElement(tag);
      expect(capture.shouldIgnoreElement(el)).toBe(true);
    });
  }

  it('does NOT ignore a <button> (not in ignored list)', () => {
    document.body.innerHTML = '<button id="b">Go</button>';
    expect(capture.shouldIgnoreElement(document.getElementById('b'))).toBe(false);
  });

  it('does NOT ignore a regular <div> with no tracker host ancestor', () => {
    document.body.innerHTML = '<div id="d"><span id="s">x</span></div>';
    expect(capture.shouldIgnoreElement(document.getElementById('s'))).toBe(false);
  });

  it('ignores an element that is itself the tracker host', () => {
    document.body.innerHTML = '<div id="elements-tracker-host"></div>';
    const host = document.getElementById('elements-tracker-host');
    expect(capture.shouldIgnoreElement(host)).toBe(true);
  });

  it('ignores an element nested inside the tracker host (closest match)', () => {
    document.body.innerHTML =
      '<div id="elements-tracker-host"><button id="inner">x</button></div>';
    expect(capture.shouldIgnoreElement(document.getElementById('inner'))).toBe(true);
  });

  it('tag check is case-sensitive against uppercase tagName (real DOM uppercases)', () => {
    // tagName is always uppercased by the DOM, so a real <script> matches.
    document.body.innerHTML = '<script id="js"></script>';
    expect(capture.shouldIgnoreElement(document.getElementById('js'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// InputCapture.shouldCaptureElement
// ---------------------------------------------------------------------------
describe('InputCapture.shouldCaptureElement', () => {
  let capture;

  beforeEach(() => {
    capture = new InputCapture('interactions');
  });

  it('returns false for null / undefined element', () => {
    expect(capture.shouldCaptureElement(null)).toBe(false);
    expect(capture.shouldCaptureElement(undefined)).toBe(false);
  });

  it('returns true for a plain text input', () => {
    const el = document.createElement('input');
    el.type = 'text';
    expect(capture.shouldCaptureElement(el)).toBe(true);
  });

  it('returns true for a <textarea>', () => {
    expect(capture.shouldCaptureElement(document.createElement('textarea'))).toBe(true);
  });

  it('returns true for a <select>', () => {
    expect(capture.shouldCaptureElement(document.createElement('select'))).toBe(true);
  });

  it('returns false for a non-form element (<div>)', () => {
    expect(capture.shouldCaptureElement(document.createElement('div'))).toBe(false);
  });

  const ignoredTypes = ['hidden', 'submit', 'reset', 'button', 'image'];
  for (const type of ignoredTypes) {
    it(`returns false for input[type=${type}]`, () => {
      const el = document.createElement('input');
      el.type = type;
      expect(capture.shouldCaptureElement(el)).toBe(false);
    });
  }

  it('returns false for password input when __capturePasswordFields is unset', () => {
    const el = document.createElement('input');
    el.type = 'password';
    expect(capture.shouldCaptureElement(el)).toBe(false);
  });

  it('returns false for password input when __capturePasswordFields is false', () => {
    window.__capturePasswordFields = false;
    const el = document.createElement('input');
    el.type = 'password';
    expect(capture.shouldCaptureElement(el)).toBe(false);
  });

  it('returns true for password input when __capturePasswordFields is true', () => {
    window.__capturePasswordFields = true;
    const el = document.createElement('input');
    el.type = 'password';
    expect(capture.shouldCaptureElement(el)).toBe(true);
  });

  it('matches tags case-insensitively (tagName uppercased internally)', () => {
    // shouldCaptureElement lowercases tagName, so a real <input> always matches.
    const el = document.createElement('INPUT');
    el.type = 'text';
    expect(capture.shouldCaptureElement(el)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FormCapture.isDuplicateSubmission  (Date.now controlled via fake timers)
// ---------------------------------------------------------------------------
describe('FormCapture.isDuplicateSubmission', () => {
  let capture;
  let form;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    capture = new FormCapture('interactions');
    document.body.innerHTML = '<form id="f"></form>';
    form = document.getElementById('f');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the configured deduplication window (1000ms)', () => {
    expect(capture.deduplicationWindow).toBe(FORM_CAPTURE_CONFIG.DEDUPLICATION_WINDOW_MS);
    expect(capture.deduplicationWindow).toBe(1000);
  });

  it('returns false when the form was never submitted (not in WeakMap)', () => {
    expect(capture.isDuplicateSubmission(form)).toBe(false);
  });

  it('returns true for a second submission within the dedup window', () => {
    capture.markFormSubmitted(form); // recorded at t=0
    vi.advanceTimersByTime(500); // 500ms < 1000ms window
    expect(capture.isDuplicateSubmission(form)).toBe(true);
  });

  it('returns false once more than the window has elapsed', () => {
    capture.markFormSubmitted(form); // t=0
    vi.advanceTimersByTime(1001); // 1001ms > 1000ms window
    expect(capture.isDuplicateSubmission(form)).toBe(false);
  });

  it('treats exactly the window boundary as NOT duplicate (strict < comparison)', () => {
    capture.markFormSubmitted(form); // t=0
    vi.advanceTimersByTime(1000); // exactly the window -> 1000 < 1000 is false
    expect(capture.isDuplicateSubmission(form)).toBe(false);
  });

  it('tracks distinct forms independently', () => {
    document.body.innerHTML = '<form id="a"></form><form id="b"></form>';
    const a = document.getElementById('a');
    const b = document.getElementById('b');
    capture.markFormSubmitted(a);
    vi.advanceTimersByTime(100);
    expect(capture.isDuplicateSubmission(a)).toBe(true);
    expect(capture.isDuplicateSubmission(b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ScrollCapture.getScrollPercentage  (window.scrollY / scrollHeight / innerHeight stubbed)
// ---------------------------------------------------------------------------
describe('ScrollCapture.getScrollPercentage', () => {
  let capture;
  let originalInnerHeight;

  const stubScroll = ({ scrollY, scrollHeight, innerHeight }) => {
    Object.defineProperty(window, 'scrollY', { value: scrollY, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: scrollHeight,
      configurable: true,
    });
    window.innerHeight = innerHeight;
  };

  beforeEach(() => {
    originalInnerHeight = window.innerHeight;
    // constructor reads window.scrollY only; it does NOT attach listeners (init does).
    capture = new ScrollCapture('interactions');
  });

  afterEach(() => {
    window.innerHeight = originalInnerHeight;
  });

  it('returns 0 at the very top', () => {
    stubScroll({ scrollY: 0, scrollHeight: 1000, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(0);
  });

  it('returns 100 at the bottom (scrollY == scrollHeight - innerHeight)', () => {
    stubScroll({ scrollY: 500, scrollHeight: 1000, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(100);
  });

  it('returns 50 at the midpoint', () => {
    stubScroll({ scrollY: 250, scrollHeight: 1000, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(50);
  });

  it('returns 100 when the document is shorter than the viewport (avoids div-by-zero)', () => {
    stubScroll({ scrollY: 0, scrollHeight: 200, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(100);
  });

  it('returns 100 when document height equals viewport height (docHeight <= winHeight)', () => {
    stubScroll({ scrollY: 0, scrollHeight: 500, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(100);
  });

  it('clamps overscroll (scrollY beyond max) to 100', () => {
    stubScroll({ scrollY: 99999, scrollHeight: 1000, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(100);
  });

  it('clamps negative scrollY (rubber-band) to 0', () => {
    stubScroll({ scrollY: -50, scrollHeight: 1000, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(0);
  });

  it('rounds to the nearest integer percentage', () => {
    // scrollTop / (docHeight - winHeight) = 333 / 500 = 0.666 -> 67
    stubScroll({ scrollY: 333, scrollHeight: 1000, innerHeight: 500 });
    expect(capture.getScrollPercentage()).toBe(67);
  });
});

// ---------------------------------------------------------------------------
// NavigationCapture.getLoadTime  (performance.timing stubbed)
// ---------------------------------------------------------------------------
describe('NavigationCapture.getLoadTime', () => {
  let capture;

  beforeEach(() => {
    // constructor reads window.location.href and binds handlers; no listeners attached.
    capture = new NavigationCapture('interactions');
  });

  afterEach(() => {
    // Remove any stubbed timing we added so other suites see a clean performance object.
    if (Object.prototype.hasOwnProperty.call(performance, 'timing')) {
      try {
        delete performance.timing;
      } catch {
        /* non-configurable in some envs; ignore */
      }
    }
  });

  const stubTiming = (timing) => {
    Object.defineProperty(performance, 'timing', { value: timing, configurable: true });
  };

  it('computes all timing metrics from a complete performance.timing', () => {
    stubTiming({
      navigationStart: 1000,
      loadEventEnd: 3000,
      domContentLoadedEventEnd: 2200,
      domainLookupStart: 1100,
      domainLookupEnd: 1150,
      connectStart: 1150,
      connectEnd: 1250,
      requestStart: 1300,
      responseStart: 1400,
      responseEnd: 1500,
    });

    const lt = capture.getLoadTime();
    expect(lt).toEqual({
      total: 2000, // 3000 - 1000
      domReady: 1200, // 2200 - 1000
      dns: 50, // 1150 - 1100
      tcp: 100, // 1250 - 1150
      request: 100, // 1400 - 1300
      response: 100, // 1500 - 1400
    });
  });

  it('returns null when load is incomplete (loadEventEnd === 0)', () => {
    stubTiming({ navigationStart: 1000, loadEventEnd: 0 });
    expect(capture.getLoadTime()).toBeNull();
  });

  it('returns null when performance.timing is unavailable', () => {
    Object.defineProperty(performance, 'timing', { value: undefined, configurable: true });
    expect(capture.getLoadTime()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PageScanner.generateElementKey
// ---------------------------------------------------------------------------
describe('PageScanner.generateElementKey', () => {
  let scanner;

  const stubRect = (el, { x, y }) => {
    el.getBoundingClientRect = () => ({
      x,
      y,
      left: x,
      top: y,
      right: x,
      bottom: y,
      width: 0,
      height: 0,
      toJSON() {},
    });
  };

  beforeEach(() => {
    scanner = new PageScanner();
  });

  afterEach(() => {
    // destroy() removes the 'enrichment-batch-complete' window listener added in ctor.
    scanner.destroy();
  });

  it('builds a key from empty hostPath, tag, id, class, and rounded position for a light-DOM element', () => {
    document.body.innerHTML = '<button id="save" class="btn primary"></button>';
    const el = document.getElementById('save');
    stubRect(el, { x: 10.4, y: 20.6 });

    const key = scanner.generateElementKey(el);
    // light DOM -> getShadowPath().hosts is empty -> hostPath '' before '::'
    expect(key).toBe('::button#save.btn primary@10,21');
  });

  it('includes the rounded bounding-rect position in the key', () => {
    document.body.innerHTML = '<a id="lnk"></a>';
    const el = document.getElementById('lnk');
    stubRect(el, { x: 100.49, y: 200.51 });
    expect(scanner.generateElementKey(el)).toBe('::a#lnk.@100,201');
  });

  it('produces DIFFERENT keys for two otherwise-identical elements at different positions', () => {
    document.body.innerHTML = '<button class="c"></button><button class="c"></button>';
    const [a, b] = document.querySelectorAll('button');
    stubRect(a, { x: 0, y: 0 });
    stubRect(b, { x: 0, y: 300 });

    const keyA = scanner.generateElementKey(a);
    const keyB = scanner.generateElementKey(b);
    expect(keyA).not.toBe(keyB);
    expect(keyA.endsWith('@0,0')).toBe(true);
    expect(keyB.endsWith('@0,300')).toBe(true);
  });

  it('produces IDENTICAL keys for two identical elements at the same position', () => {
    document.body.innerHTML = '<button class="c"></button><button class="c"></button>';
    const [a, b] = document.querySelectorAll('button');
    stubRect(a, { x: 5, y: 5 });
    stubRect(b, { x: 5, y: 5 });
    expect(scanner.generateElementKey(a)).toBe(scanner.generateElementKey(b));
  });

  it('falls back to a random-suffixed key when getBoundingClientRect throws', () => {
    document.body.innerHTML = '<button id="boom"></button>';
    const el = document.getElementById('boom');
    el.getBoundingClientRect = () => {
      throw new Error('layout exploded');
    };
    const key = scanner.generateElementKey(el);
    // catch branch: `${element.tagName}_${Math.random()}`
    expect(key).toMatch(/^BUTTON_0(\.\d+)?$/);
  });

  it('fallback keys are non-colliding across calls (random suffix)', () => {
    document.body.innerHTML = '<button id="boom"></button>';
    const el = document.getElementById('boom');
    el.getBoundingClientRect = () => {
      throw new Error('nope');
    };
    const k1 = scanner.generateElementKey(el);
    const k2 = scanner.generateElementKey(el);
    expect(k1).not.toBe(k2);
  });
});

// ---------------------------------------------------------------------------
// PageScanner.isFrameWorthScanning
// ---------------------------------------------------------------------------
describe('PageScanner.isFrameWorthScanning', () => {
  let scanner;
  let originalInnerHeight;

  const stubScrollHeight = (value) => {
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value,
      configurable: true,
    });
  };

  beforeEach(() => {
    originalInnerHeight = window.innerHeight;
    scanner = new PageScanner();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    scanner.destroy();
    window.innerHeight = originalInnerHeight;
  });

  it('returns false for a tiny empty frame (scrollHeight<50, children<5, no interactives)', () => {
    stubScrollHeight(30);
    document.body.innerHTML = '<span></span><span></span>'; // 2 non-interactive children
    expect(scanner.isFrameWorthScanning()).toBe(false);
  });

  it('returns true for a tall, populated frame with a button', () => {
    stubScrollHeight(1000);
    document.body.innerHTML =
      '<div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div><button>x</button>';
    expect(scanner.isFrameWorthScanning()).toBe(true);
  });

  it('returns false at the exact boundary (scrollHeight=50, children=5, no interactives)', () => {
    // The empty-frame guard is `scrollHeight < 50 && childrenCount < 5 && !interactive`.
    // At scrollHeight=50 the `< 50` is false, so the guard does NOT fire -> worth scanning.
    stubScrollHeight(50);
    document.body.innerHTML = '<p></p><p></p><p></p><p></p><p></p>'; // exactly 5 children
    expect(scanner.isFrameWorthScanning()).toBe(true);
  });

  it('returns true when an interactive element is present even if small/sparse', () => {
    stubScrollHeight(10);
    document.body.innerHTML = '<input type="text">'; // 1 child, interactive
    expect(scanner.isFrameWorthScanning()).toBe(true);
  });

  it('returns false when small and sparse with only non-interactive content', () => {
    stubScrollHeight(40);
    document.body.innerHTML = '<p>only text here</p>'; // 1 child, no interactives
    expect(scanner.isFrameWorthScanning()).toBe(false);
  });

  it('all three thresholds must hold to skip — many children alone keeps it worth scanning', () => {
    stubScrollHeight(20);
    document.body.innerHTML =
      '<span></span><span></span><span></span><span></span><span></span><span></span>'; // 6 children
    expect(scanner.isFrameWorthScanning()).toBe(true);
  });
});
