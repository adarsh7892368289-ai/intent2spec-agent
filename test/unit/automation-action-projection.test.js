import { describe, it, expect } from 'vitest';
import {
  projectStep,
  projectSteps,
  toPlaywrightScript,
  buildAutomationPayload,
} from '@core/automation/action-projection.js';
import { projectLocators, recommendedLocator } from '@core/automation/locator-projection.js';

// ---------------------------------------------------------------------------
// Recording-event fixtures. These mirror the enriched-element shape the engine
// emits: captureType + name + tagName + metadata + selectors + eventData.
// We deliberately give clickable elements a real role/name so the REAL
// locator-projection produces a deterministic getByRole locator we can assert.
// ---------------------------------------------------------------------------

function clickButton(name = 'Save') {
  return {
    captureType: 'click',
    name,
    tagName: 'button',
    metadata: { tag: 'button' },
  };
}

function textInput({ name = 'Email', value = 'a@b.com', testId } = {}) {
  const meta = { tag: 'input', type: 'text' };
  if (testId) {
    meta.dataAttributes = { 'data-testid': testId };
  }
  return {
    captureType: 'input',
    name,
    tagName: 'input',
    metadata: meta,
    eventData: { input: { inputType: 'text', value } },
  };
}

function checkboxInput({ checked = true, name = 'Accept terms' } = {}) {
  return {
    captureType: 'input',
    name,
    tagName: 'input',
    metadata: { tag: 'input', type: 'checkbox' },
    eventData: { input: { inputType: 'checkbox', checked } },
  };
}

function radioInput({ checked = true, name = 'Option A' } = {}) {
  return {
    captureType: 'input',
    name,
    tagName: 'input',
    metadata: { tag: 'input', type: 'radio' },
    eventData: { input: { inputType: 'radio', checked } },
  };
}

function passwordInput({ name = 'Password' } = {}) {
  return {
    captureType: 'input',
    name,
    tagName: 'input',
    metadata: { tag: 'input', type: 'password' },
    eventData: { input: { inputType: 'password', value: 'hunter2' } },
  };
}

function selectInput({ name = 'Country', value = 'US' } = {}) {
  return {
    captureType: 'input',
    name,
    tagName: 'select',
    metadata: { tag: 'select' },
    eventData: { input: { inputType: 'select-one', value } },
  };
}

function formCapture({ name = 'Login form' } = {}) {
  return {
    captureType: 'form',
    name,
    tagName: 'form',
    metadata: { tag: 'form', role: 'form' },
  };
}

function navEvent(to, method = 'pushState') {
  return {
    captureType: 'navigation',
    eventData: { navigation: { to, method } },
  };
}

function scrollEvent(scrollY) {
  return {
    captureType: 'scroll',
    eventData: { scroll: { scrollY } },
  };
}

function scanRow({ name = 'Hero banner', tag = 'section' } = {}) {
  // No captureType actionable path + has a CSS selector so a locator exists.
  return {
    name,
    tagName: tag,
    metadata: { tag },
    selectors: { css: { selector: '.hero', tier: 3 } },
  };
}

describe('projectStep', () => {
  it('returns null for null / undefined / non-object input', () => {
    expect(projectStep(null, 0)).toBeNull();
    expect(projectStep(undefined, 0)).toBeNull();
    expect(projectStep('not-an-object', 0)).toBeNull();
    expect(projectStep(42, 0)).toBeNull();
  });

  it('projects a navigation step with action=navigate, url, method and goto code', () => {
    const step = projectStep(navEvent('https://example.com/next', 'pushState'), 2);
    expect(step).toMatchObject({
      index: 2,
      action: 'navigate',
      url: 'https://example.com/next',
      method: 'pushState',
    });
    expect(step.code).toBe("await page.goto('https://example.com/next');");
  });

  it('returns null for navigation when eventData.navigation.to is missing', () => {
    expect(projectStep({ captureType: 'navigation', eventData: { navigation: {} } }, 0)).toBeNull();
    expect(projectStep({ captureType: 'navigation', eventData: {} }, 0)).toBeNull();
    expect(projectStep({ captureType: 'navigation' }, 0)).toBeNull();
  });

  it('defaults navigation method to null when absent', () => {
    const step = projectStep({ captureType: 'navigation', eventData: { navigation: { to: 'https://x.test/' } } }, 0);
    expect(step.method).toBeNull();
  });

  it('projects a scroll step with mouse.wheel code (rounded scrollY)', () => {
    const step = projectStep(scrollEvent(450.7), 1);
    expect(step.action).toBe('scroll');
    expect(step.scrollY).toBe(450.7);
    expect(step.code).toBe('await page.mouse.wheel(0, 451);');
    expect(step.note).toMatch(/auto-scroll/i);
  });

  it('projects a scroll step with placeholder code when scrollY is null', () => {
    const step = projectStep({ captureType: 'scroll', eventData: { scroll: {} } }, 0);
    expect(step.action).toBe('scroll');
    expect(step.scrollY).toBeNull();
    expect(step.code).toBe('// scroll');
  });

  it('projects a click step with locator, alternates and click code', () => {
    const el = clickButton('Save');
    const step = projectStep(el, 0);
    const locators = projectLocators(el);
    expect(step.action).toBe('click');
    expect(step.name).toBe('Save');
    expect(step.locator).toEqual(locators[0]);
    expect(step.alternates).toEqual(locators.slice(1));
    expect(step.code).toBe(`await ${locators[0].code}.click();`);
    // sanity: the real projection chose getByRole('button', { name: 'Save' })
    expect(step.code).toBe("await page.getByRole('button', { name: 'Save' }).click();");
  });

  it('returns a check step for a checked checkbox input', () => {
    const step = projectStep(checkboxInput({ checked: true }), 0);
    expect(step.action).toBe('check');
    expect(step.code).toMatch(/\.check\(\);$/);
  });

  it('returns an uncheck step for an unchecked checkbox input', () => {
    const step = projectStep(checkboxInput({ checked: false }), 0);
    expect(step.action).toBe('uncheck');
    expect(step.code).toMatch(/\.uncheck\(\);$/);
  });

  it('treats radio inputs the same as checkboxes (check / uncheck)', () => {
    expect(projectStep(radioInput({ checked: true }), 0).action).toBe('check');
    expect(projectStep(radioInput({ checked: false }), 0).action).toBe('uncheck');
  });

  it('treats a non-boolean checked value as unchecked', () => {
    // input.checked === true is the only path to 'check'; anything else -> uncheck.
    const step = projectStep(
      {
        captureType: 'input',
        name: 'cb',
        tagName: 'input',
        metadata: { tag: 'input', type: 'checkbox' },
        eventData: { input: { inputType: 'checkbox', checked: 'true' } },
      },
      0,
    );
    expect(step.action).toBe('uncheck');
  });

  it('returns a fill step with secret=true and masked value for password inputs', () => {
    const step = projectStep(passwordInput(), 0);
    expect(step.action).toBe('fill');
    expect(step.secret).toBe(true);
    expect(step.value).toBe('«password»');
    // never leak the captured password into the generated code
    expect(step.code).not.toContain('hunter2');
    expect(step.code).toContain('TODO: inject secret');
    expect(step.code).toContain('«password»');
  });

  it('returns a selectOption step for select elements (value from capture)', () => {
    const step = projectStep(selectInput({ value: 'US' }), 0);
    expect(step.action).toBe('selectOption');
    expect(step.value).toBe('US');
    expect(step.code).toMatch(/\.selectOption\('US'\);$/);
  });

  it('returns a fill step for ordinary text inputs with the captured value', () => {
    const step = projectStep(textInput({ value: 'jane@doe.com' }), 0);
    expect(step.action).toBe('fill');
    expect(step.value).toBe('jane@doe.com');
    expect(step.code).toMatch(/\.fill\('jane@doe\.com'\);$/);
  });

  it('defaults input value to empty string when eventData.input is missing', () => {
    const el = {
      captureType: 'input',
      name: 'Email',
      tagName: 'input',
      metadata: { tag: 'input', type: 'text' },
    };
    const step = projectStep(el, 0);
    expect(step.action).toBe('fill');
    expect(step.value).toBe('');
    expect(step.code).toMatch(/\.fill\(''\);$/);
  });

  it('returns a submit step for form captures', () => {
    const step = projectStep(formCapture(), 0);
    expect(step.action).toBe('submit');
    expect(step.code).toMatch(/\.click\(\); \/\/ submit$/);
  });

  it('returns a locate step (fallback) for non-actionable scan rows', () => {
    const el = scanRow({ name: 'Hero banner' });
    const step = projectStep(el, 0);
    expect(step.action).toBe('locate');
    expect(step.name).toBe('Hero banner');
    expect(step.code).toContain('// Hero banner');
    expect(step.locator).toEqual(projectLocators(el)[0]);
  });

  it('passes the index through to the produced step', () => {
    expect(projectStep(clickButton(), 7).index).toBe(7);
    expect(projectStep(navEvent('https://x.test/'), 9).index).toBe(9);
    expect(projectStep(scrollEvent(10), 4).index).toBe(4);
  });

  it('returns null for an actionable type whose element yields no locator', () => {
    // A click with no role, no name, no selectors -> projectLocators returns [] -> best null.
    const el = { captureType: 'click', tagName: 'div', metadata: { tag: 'div' } };
    expect(projectLocators(el)).toEqual([]);
    expect(projectStep(el, 0)).toBeNull();
  });

  it('defaults el.name to empty string when missing on a locatable element', () => {
    const el = {
      captureType: 'click',
      tagName: 'button',
      metadata: { tag: 'button', role: 'button' },
    };
    const step = projectStep(el, 0);
    expect(step).not.toBeNull();
    expect(step.name).toBe('');
  });

  it('falls through to locate for an unknown / missing captureType (still locatable)', () => {
    const el = scanRow();
    delete el.captureType;
    expect(projectStep(el, 0).action).toBe('locate');
  });

  it('includes the best locator and the remaining ranked locators as alternates', () => {
    // testId + role/name -> at least 2 locators, so alternates is non-empty.
    const el = textInput({ name: 'Email', testId: 'email-field', value: 'x' });
    const locators = projectLocators(el);
    expect(locators.length).toBeGreaterThan(1);
    const step = projectStep(el, 0);
    expect(step.locator).toEqual(locators[0]);
    expect(step.locator.kind).toBe('testId');
    expect(step.alternates).toEqual(locators.slice(1));
    expect(step.alternates.length).toBe(locators.length - 1);
  });
});

describe('projectSteps', () => {
  it('returns [] when elements is not an array', () => {
    expect(projectSteps(null)).toEqual([]);
    expect(projectSteps(undefined)).toEqual([]);
    expect(projectSteps('nope')).toEqual([]);
    expect(projectSteps({ length: 2 })).toEqual([]);
  });

  it('returns [] for an empty array', () => {
    expect(projectSteps([])).toEqual([]);
  });

  it('projects each actionable element and preserves capture order', () => {
    const steps = projectSteps([
      navEvent('https://shop.test/'),
      clickButton('Add to cart'),
      formCapture(),
    ]);
    expect(steps.map((s) => s.action)).toEqual(['navigate', 'click', 'submit']);
  });

  it('filters out elements that project to null and re-indexes the survivors', () => {
    const nonActionable = { captureType: 'click', tagName: 'div', metadata: { tag: 'div' } }; // null
    const steps = projectSteps([
      clickButton('First'),
      nonActionable, // skipped
      clickButton('Second'),
      { captureType: 'navigation', eventData: { navigation: {} } }, // null (no `to`)
      clickButton('Third'),
    ]);
    expect(steps).toHaveLength(3);
    // index increments ONLY for kept steps -> contiguous 0,1,2 (no gaps).
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(steps.map((s) => s.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('skips null entries inside the array without throwing', () => {
    const steps = projectSteps([null, clickButton('Only'), undefined]);
    expect(steps).toHaveLength(1);
    expect(steps[0].index).toBe(0);
  });
});

describe('toPlaywrightScript', () => {
  it('emits the @playwright/test import, a titled test block and a closing brace', () => {
    const script = toPlaywrightScript({ url: 'https://app.test/' }, [clickButton('Save')]);
    const lines = script.split('\n');
    expect(lines[0]).toBe("import { test, expect } from '@playwright/test';");
    expect(lines[1]).toBe('');
    expect(script).toMatch(/test\('.*', async \(\{ page \}\) => \{/);
    expect(lines[lines.length - 1]).toBe('});');
  });

  it('inserts page.goto(startUrl) from report.url and indents body 2 spaces', () => {
    const script = toPlaywrightScript({ url: 'https://app.test/login' }, [clickButton('Save')]);
    expect(script).toContain("  await page.goto('https://app.test/login');");
    expect(script).toContain("  await page.getByRole('button', { name: 'Save' }).click();");
  });

  it('derives startUrl from the first navigate step when report.url is missing', () => {
    const script = toPlaywrightScript(
      { mode: 'record', host: 'shop.test' },
      [navEvent('https://shop.test/start'), clickButton('Go')],
    );
    expect(script).toContain("  await page.goto('https://shop.test/start');");
    // the navigate step equal to startUrl must NOT be emitted a second time
    const gotoCount = (script.match(/page\.goto\('https:\/\/shop\.test\/start'\)/g) || []).length;
    expect(gotoCount).toBe(1);
  });

  it('keeps a navigate step whose url differs from startUrl', () => {
    const script = toPlaywrightScript(
      { url: 'https://shop.test/' },
      [clickButton('Go'), navEvent('https://shop.test/checkout')],
    );
    expect(script).toContain("  await page.goto('https://shop.test/');");
    expect(script).toContain("  await page.goto('https://shop.test/checkout');");
  });

  it('uses opts.title verbatim when provided', () => {
    const script = toPlaywrightScript({ url: 'https://app.test/' }, [], { title: 'my custom flow' });
    expect(script).toContain("test('my custom flow', async ({ page }) => {");
  });

  it('falls back to mode+host title when opts.title is empty and report has mode/host', () => {
    const script = toPlaywrightScript({ mode: 'record', host: 'app.test' }, [], { title: '' });
    expect(script).toContain("test('record – app.test', async ({ page }) => {");
  });

  it('falls back through mode -> host -> url -> flow in the derived title', () => {
    expect(toPlaywrightScript({ mode: 'scan' }, [])).toContain("scan – flow");
    expect(toPlaywrightScript({ url: 'https://only-url.test/' }, [])).toContain('recording – https://only-url.test/');
    expect(toPlaywrightScript(null, [])).toContain("test('recording – flow'");
  });

  it('omits the goto line entirely when no startUrl can be determined', () => {
    const script = toPlaywrightScript(null, [clickButton('Save')]);
    expect(script).not.toContain('page.goto(');
    expect(script).toContain("await page.getByRole('button', { name: 'Save' }).click();");
  });

  it('handles an empty steps array (header + empty body + close)', () => {
    const script = toPlaywrightScript({ url: 'https://app.test/' }, []);
    expect(script).toBe(
      [
        "import { test, expect } from '@playwright/test';",
        '',
        "test('recording – https://app.test/', async ({ page }) => {",
        "  await page.goto('https://app.test/');",
        '});',
      ].join('\n'),
    );
  });

  it('handles a non-array elements argument without throwing (no body lines)', () => {
    const script = toPlaywrightScript({ url: 'https://app.test/' }, null);
    expect(script).toContain("  await page.goto('https://app.test/');");
    expect(script.split('\n').filter((l) => l.startsWith('  await')).length).toBe(1);
  });

  it('emits every body step joined by newlines in capture order', () => {
    const script = toPlaywrightScript(
      { url: 'https://shop.test/' },
      [textInput({ name: 'Email', value: 'a@b.com' }), clickButton('Submit')],
    );
    const bodyLines = script.split('\n').filter((l) => l.startsWith('  await') && !l.includes('page.goto'));
    // A named text input ranks getByRole (priority 2) above getByLabel (priority 4).
    expect(bodyLines).toEqual([
      "  await page.getByRole('textbox', { name: 'Email' }).fill('a@b.com');",
      "  await page.getByRole('button', { name: 'Submit' }).click();",
    ]);
  });
});

describe('buildAutomationPayload', () => {
  it('returns an object with exactly report, inventory and steps keys', () => {
    const payload = buildAutomationPayload({ id: 'r1' }, []);
    expect(Object.keys(payload).sort()).toEqual(['inventory', 'report', 'steps']);
  });

  it('projects the report meta subset (id, mode, url, host, timestamp)', () => {
    const report = {
      id: 'rep-1',
      mode: 'record',
      url: 'https://app.test/',
      host: 'app.test',
      timestamp: 1700000000000,
      extra: 'dropped',
    };
    const payload = buildAutomationPayload(report, []);
    expect(payload.report).toEqual({
      id: 'rep-1',
      mode: 'record',
      url: 'https://app.test/',
      host: 'app.test',
      timestamp: 1700000000000,
    });
    expect(payload.report).not.toHaveProperty('extra');
  });

  it('sets report to null when the input report is falsy', () => {
    expect(buildAutomationPayload(null, []).report).toBeNull();
    expect(buildAutomationPayload(undefined, []).report).toBeNull();
    expect(buildAutomationPayload(0, []).report).toBeNull();
  });

  it('carries through individual undefined report fields as undefined', () => {
    const payload = buildAutomationPayload({ id: 'x' }, []);
    expect(payload.report.id).toBe('x');
    expect(payload.report.mode).toBeUndefined();
    expect(payload.report.url).toBeUndefined();
    expect(payload.report.host).toBeUndefined();
    expect(payload.report.timestamp).toBeUndefined();
  });

  it('maps each element to a full inventory entry with the real locator output', () => {
    const el = clickButton('Save');
    const payload = buildAutomationPayload({ id: 'r' }, [el]);
    expect(payload.inventory).toHaveLength(1);
    const entry = payload.inventory[0];
    expect(entry).toEqual({
      name: 'Save',
      role: 'button',
      captureType: 'click',
      locators: projectLocators(el),
      recommended: recommendedLocator(el),
    });
    expect(entry.recommended).toEqual(entry.locators[0]);
  });

  it('inventory is an empty array when elements is null or not an array', () => {
    expect(buildAutomationPayload({ id: 'r' }, null).inventory).toEqual([]);
    expect(buildAutomationPayload({ id: 'r' }, undefined).inventory).toEqual([]);
    expect(buildAutomationPayload({ id: 'r' }, 'oops').inventory).toEqual([]);
  });

  it('inventory.role falls back to metadata.tag when tagName is absent', () => {
    const el = { name: 'Widget', metadata: { tag: 'custom-widget' }, captureType: 'click' };
    const entry = buildAutomationPayload(null, [el]).inventory[0];
    expect(entry.role).toBe('custom-widget');
  });

  it('inventory.role and name default to empty string when nothing is available', () => {
    const entry = buildAutomationPayload(null, [{}]).inventory[0];
    expect(entry.name).toBe('');
    expect(entry.role).toBe('');
  });

  it('inventory.captureType defaults to "scan" when not present', () => {
    const entry = buildAutomationPayload(null, [{ name: 'x', tagName: 'div' }]).inventory[0];
    expect(entry.captureType).toBe('scan');
  });

  it('steps equals projectSteps(elements)', () => {
    const elements = [navEvent('https://app.test/'), clickButton('Save'), formCapture()];
    const payload = buildAutomationPayload({ id: 'r' }, elements);
    expect(payload.steps).toEqual(projectSteps(elements));
    expect(payload.steps.map((s) => s.action)).toEqual(['navigate', 'click', 'submit']);
  });

  it('produces empty inventory and steps for an empty elements array', () => {
    const payload = buildAutomationPayload({ id: 'r' }, []);
    expect(payload.inventory).toEqual([]);
    expect(payload.steps).toEqual([]);
  });
});
