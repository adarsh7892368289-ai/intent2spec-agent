import { describe, it, expect } from 'vitest';
import {
  accessibleName,
  inferRole,
  projectLocators,
  recommendedLocator,
} from '@core/automation/locator-projection.js';

// -----------------------------------------------------------------------------
// Fixture helpers: build realistic serialized enriched-element objects.
// Mirrors the shape the engine emits (tagName, name/label, metadata with aria/
// data attributes, selectors.css / selectors.xpath, shadowDOM flag).
// -----------------------------------------------------------------------------
function el(overrides = {}) {
  return {
    tagName: 'button',
    name: 'Save',
    label: 'Save',
    metadata: {},
    selectors: {},
    ...overrides,
  };
}

function kindsOf(locators) {
  return locators.map((l) => l.kind);
}

function byKind(locators, kind) {
  return locators.find((l) => l.kind === kind);
}

describe('accessibleName', () => {
  it('returns trimmed name when name is a non-empty meaningful string', () => {
    expect(accessibleName({ name: '  Submit  ', label: 'ignored' })).toBe('Submit');
  });

  it("falls back to label when name === 'Unknown'", () => {
    expect(accessibleName({ name: 'Unknown', label: 'Real Label' })).toBe('Real Label');
  });

  it("falls back to label when name === 'Unknown Element'", () => {
    expect(accessibleName({ name: 'Unknown Element', label: 'Real Label' })).toBe('Real Label');
  });

  it('falls back to (trimmed) label when name is whitespace-only', () => {
    expect(accessibleName({ name: '   ', label: '  Email  ' })).toBe('Email');
  });

  it('returns empty string when both name and label are missing', () => {
    expect(accessibleName({})).toBe('');
  });

  it('returns empty string when both name and label are whitespace-only', () => {
    expect(accessibleName({ name: '  ', label: '\t\n' })).toBe('');
  });

  it('returns empty string for null', () => {
    expect(accessibleName(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(accessibleName(undefined)).toBe('');
  });

  it('treats a non-string name as absent and falls back to label', () => {
    expect(accessibleName({ name: 42, label: 'Label' })).toBe('Label');
  });
});

describe('inferRole', () => {
  it('returns explicit role from metadata.ariaAttributes.role', () => {
    expect(inferRole({ tagName: 'div', metadata: { ariaAttributes: { role: 'tab' } } })).toBe('tab');
  });

  it('returns explicit role from metadata.role when ariaAttributes.role absent', () => {
    expect(inferRole({ tagName: 'div', metadata: { role: 'menuitem' } })).toBe('menuitem');
  });

  it('prefers ariaAttributes.role over metadata.role', () => {
    expect(
      inferRole({ tagName: 'div', metadata: { role: 'menuitem', ariaAttributes: { role: 'tab' } } })
    ).toBe('tab');
  });

  it('infers implicit role from tag (button -> button)', () => {
    expect(inferRole({ tagName: 'button' })).toBe('button');
  });

  it('infers implicit role from tag (a -> link)', () => {
    expect(inferRole({ tagName: 'a' })).toBe('link');
  });

  it('infers implicit role for headings (h3 -> heading)', () => {
    expect(inferRole({ tagName: 'h3' })).toBe('heading');
  });

  it('infers combobox for select', () => {
    expect(inferRole({ tagName: 'select' })).toBe('combobox');
  });

  it('infers textbox for textarea', () => {
    expect(inferRole({ tagName: 'textarea' })).toBe('textbox');
  });

  it('infers role from input type (checkbox -> checkbox)', () => {
    expect(inferRole({ tagName: 'input', metadata: { type: 'checkbox' } })).toBe('checkbox');
  });

  it('infers textbox for input type=email', () => {
    expect(inferRole({ tagName: 'input', metadata: { type: 'email' } })).toBe('textbox');
  });

  it('infers spinbutton for input type=number', () => {
    expect(inferRole({ tagName: 'input', metadata: { type: 'number' } })).toBe('spinbutton');
  });

  it('defaults input with no type to textbox', () => {
    expect(inferRole({ tagName: 'input', metadata: {} })).toBe('textbox');
  });

  it('defaults input with unknown type to textbox', () => {
    expect(inferRole({ tagName: 'input', metadata: { type: 'foobar' } })).toBe('textbox');
  });

  it('is case-insensitive on tag name (BUTTON -> button)', () => {
    expect(inferRole({ tagName: 'BUTTON' })).toBe('button');
  });

  it('is case-insensitive on input type (CHECKBOX -> checkbox)', () => {
    expect(inferRole({ tagName: 'Input', metadata: { type: 'CHECKBOX' } })).toBe('checkbox');
  });

  it('returns null when no role can be inferred (plain div)', () => {
    expect(inferRole({ tagName: 'div' })).toBeNull();
  });

  it('handles metadata.ariaAttributes === null without throwing', () => {
    expect(inferRole({ tagName: 'a', metadata: { ariaAttributes: null } })).toBe('link');
  });

  it('uses el.tagName over metadata.tag for implicit role', () => {
    // tagName=a (link) should win over metadata.tag=div (null)
    expect(inferRole({ tagName: 'a', metadata: { tag: 'div' } })).toBe('link');
  });

  it('falls back to metadata.tag when tagName is absent', () => {
    expect(inferRole({ metadata: { tag: 'select' } })).toBe('combobox');
  });

  it('returns null for null/undefined element without throwing', () => {
    expect(inferRole(null)).toBeNull();
    expect(inferRole(undefined)).toBeNull();
  });
});

describe('projectLocators — invalid inputs', () => {
  it('returns empty array for null', () => {
    expect(projectLocators(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(projectLocators(undefined)).toEqual([]);
  });

  it('returns empty array for a non-object (string)', () => {
    expect(projectLocators('not-an-object')).toEqual([]);
  });

  it('returns empty array for a number', () => {
    expect(projectLocators(123)).toEqual([]);
  });

  it('returns empty array for a fully empty element (no signals at all)', () => {
    expect(projectLocators({ metadata: {}, selectors: {} })).toEqual([]);
  });
});

describe('projectLocators — testId (priority 1)', () => {
  it('emits a priority-1 testId locator from data-testid (dash key)', () => {
    const out = projectLocators(
      el({ metadata: { dataAttributes: { 'data-testid': 'save-btn' } } })
    );
    const tid = byKind(out, 'testId');
    expect(tid).toBeTruthy();
    expect(tid.priority).toBe(1);
    expect(tid.value).toBe('save-btn');
    expect(tid.attr).toBe('data-testid');
    expect(tid.code).toBe("page.getByTestId('save-btn')");
  });

  it('reads the test id from the dataset key (data- prefix stripped, "testid")', () => {
    // The DOM dataset key for `data-testid` is `testid` (no internal hyphen to
    // camelCase). The engine strips `data-` and camelCases the remainder.
    const out = projectLocators(
      el({ metadata: { dataAttributes: { testid: 'ds-id' } } })
    );
    const tid = byKind(out, 'testId');
    expect(tid).toBeTruthy();
    expect(tid.value).toBe('ds-id');
    expect(tid.attr).toBe('data-testid');
  });

  it('camelCases multi-segment dataset keys (data-automation-id -> automationId)', () => {
    const out = projectLocators(
      el({ metadata: { dataAttributes: { automationId: 'auto-ds' } } })
    );
    const tid = byKind(out, 'testId');
    expect(tid).toBeTruthy();
    expect(tid.value).toBe('auto-ds');
    expect(tid.attr).toBe('data-automation-id');
  });

  it('honors TEST_ID_ATTRS precedence: data-testid wins over data-qa', () => {
    const out = projectLocators(
      el({
        metadata: {
          dataAttributes: { 'data-qa': 'qa-id', 'data-testid': 'primary-id' },
        },
      })
    );
    expect(byKind(out, 'testId').value).toBe('primary-id');
  });

  it('falls through to data-cy when higher-priority attrs are absent', () => {
    const out = projectLocators(
      el({ metadata: { dataAttributes: { 'data-cy': 'cy-id' } } })
    );
    const tid = byKind(out, 'testId');
    expect(tid.value).toBe('cy-id');
    expect(tid.attr).toBe('data-cy');
  });

  it('supports data-automation-id', () => {
    const out = projectLocators(
      el({ metadata: { dataAttributes: { 'data-automation-id': 'auto-id' } } })
    );
    expect(byKind(out, 'testId').value).toBe('auto-id');
  });

  it('treats an empty-string test id value as absent', () => {
    const out = projectLocators(
      el({ tagName: 'div', name: '', label: '', metadata: { dataAttributes: { 'data-testid': '   ' } } })
    );
    expect(byKind(out, 'testId')).toBeUndefined();
  });

  it('ranks testId ahead of role+name', () => {
    const out = projectLocators(
      el({ metadata: { dataAttributes: { 'data-testid': 'save-btn' } } })
    );
    expect(out[0].kind).toBe('testId');
    expect(out[0].priority).toBeLessThan(out[1].priority);
  });
});

describe('projectLocators — role (priority 2 / 3)', () => {
  it('emits role+name as priority 2 when both role and accessible name exist', () => {
    const out = projectLocators(el({ tagName: 'button', name: 'Save', label: 'Save' }));
    const role = byKind(out, 'role');
    expect(role.priority).toBe(2);
    expect(role.role).toBe('button');
    expect(role.name).toBe('Save');
    expect(role.code).toBe("page.getByRole('button', { name: 'Save' })");
  });

  it('emits role-only as priority 3 when role exists but no accessible name', () => {
    const out = projectLocators({
      tagName: 'button',
      name: '',
      label: '',
      metadata: {},
      selectors: {},
    });
    const role = byKind(out, 'role');
    expect(role.priority).toBe(3);
    expect(role.role).toBe('button');
    expect(role.name).toBeUndefined();
    expect(role.code).toBe("page.getByRole('button')");
  });

  it('emits no role locator when role cannot be inferred', () => {
    const out = projectLocators({
      tagName: 'span',
      name: '',
      label: '',
      metadata: {},
      selectors: {},
    });
    expect(byKind(out, 'role')).toBeUndefined();
  });
});

describe('projectLocators — label (priority 4)', () => {
  it('emits a label locator for a named input form field', () => {
    const out = projectLocators(
      el({ tagName: 'input', name: 'Email', label: 'Email', metadata: { type: 'email' } })
    );
    const label = byKind(out, 'label');
    expect(label.priority).toBe(4);
    expect(label.value).toBe('Email');
    expect(label.code).toBe("page.getByLabel('Email')");
  });

  it('emits a label locator for select and textarea', () => {
    const sel = projectLocators(el({ tagName: 'select', name: 'Country', label: 'Country' }));
    const ta = projectLocators(el({ tagName: 'textarea', name: 'Bio', label: 'Bio' }));
    expect(byKind(sel, 'label')).toBeTruthy();
    expect(byKind(ta, 'label')).toBeTruthy();
  });

  it('does NOT emit a label locator for non-form elements (button)', () => {
    const out = projectLocators(el({ tagName: 'button', name: 'Save', label: 'Save' }));
    expect(byKind(out, 'label')).toBeUndefined();
  });

  it('does NOT emit a label locator for a form field with no accessible name', () => {
    const out = projectLocators({
      tagName: 'input',
      name: '',
      label: '',
      metadata: { type: 'text' },
      selectors: {},
    });
    expect(byKind(out, 'label')).toBeUndefined();
  });
});

describe('projectLocators — placeholder (priority 5)', () => {
  it('emits a placeholder locator when metadata.placeholder is present', () => {
    const out = projectLocators(
      el({ tagName: 'input', name: 'Search', label: 'Search', metadata: { type: 'text', placeholder: 'Search products' } })
    );
    const ph = byKind(out, 'placeholder');
    expect(ph.priority).toBe(5);
    expect(ph.value).toBe('Search products');
    expect(ph.code).toBe("page.getByPlaceholder('Search products')");
  });

  it('emits placeholder even when there is no accessible name', () => {
    const out = projectLocators({
      tagName: 'input',
      name: '',
      label: '',
      metadata: { type: 'text', placeholder: 'Type here' },
      selectors: {},
    });
    expect(byKind(out, 'placeholder')).toBeTruthy();
    // no name -> no label locator, but placeholder still present
    expect(byKind(out, 'label')).toBeUndefined();
  });

  it('treats empty/whitespace placeholder as absent', () => {
    const out = projectLocators(
      el({ tagName: 'input', name: 'X', label: 'X', metadata: { type: 'text', placeholder: '   ' } })
    );
    expect(byKind(out, 'placeholder')).toBeUndefined();
  });
});

describe('projectLocators — text (priority 6)', () => {
  it('emits a text locator for a non-form element with a name <= 80 chars', () => {
    const out = projectLocators(el({ tagName: 'a', name: 'Read more', label: 'Read more' }));
    const text = byKind(out, 'text');
    expect(text.priority).toBe(6);
    expect(text.value).toBe('Read more');
    expect(text.code).toBe("page.getByText('Read more', { exact: true })");
  });

  it('does NOT emit a text locator when the name exceeds 80 chars', () => {
    const longName = 'x'.repeat(81);
    const out = projectLocators(el({ tagName: 'a', name: longName, label: longName }));
    expect(byKind(out, 'text')).toBeUndefined();
  });

  it('emits a text locator at exactly 80 chars (boundary, inclusive)', () => {
    const name = 'x'.repeat(80);
    const out = projectLocators(el({ tagName: 'a', name, label: name }));
    expect(byKind(out, 'text')).toBeTruthy();
  });

  it('does NOT emit a text locator for form fields', () => {
    const out = projectLocators(
      el({ tagName: 'input', name: 'Email', label: 'Email', metadata: { type: 'email' } })
    );
    expect(byKind(out, 'text')).toBeUndefined();
  });
});

describe('projectLocators — css (priority 7)', () => {
  it('emits a css locator from selectors.css.selector', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: { css: { selector: '.card > .btn', tier: 2 } },
    });
    const css = byKind(out, 'css');
    expect(css.priority).toBe(7);
    expect(css.value).toBe('.card > .btn');
    expect(css.code).toBe("page.locator('.card > .btn')");
    expect(css.robustness).toBe(2);
  });

  it('css.robustness is null when tier is absent', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: { css: { selector: '#x' } },
    });
    expect(byKind(out, 'css').robustness).toBeNull();
  });

  it('treats empty css selector as absent', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: { css: { selector: '' } },
    });
    expect(byKind(out, 'css')).toBeUndefined();
  });
});

describe('projectLocators — xpath (priority 8)', () => {
  it('emits xpath locators for primary/fallback1/fallback2', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: {
        xpath: {
          primary: '//div[@id="a"]',
          fallback1: '//div[2]',
          fallback2: '//section/div',
          robustness: 77,
        },
      },
    });
    const xps = out.filter((l) => l.kind === 'xpath');
    expect(xps).toHaveLength(3);
    expect(xps.map((x) => x.value)).toEqual([
      '//div[@id="a"]',
      '//div[2]',
      '//section/div',
    ]);
    expect(xps.every((x) => x.priority === 8)).toBe(true);
    expect(xps[0].source).toBe('xpath-engine:primary');
    expect(xps[1].source).toBe('xpath-engine:fallback1');
    expect(xps[2].source).toBe('xpath-engine:fallback2');
    expect(xps[0].robustness).toBe(77);
    expect(xps[0].code).toBe("page.locator('xpath=//div[@id=\"a\"]')");
  });

  it('skips missing xpath fallback keys', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: { xpath: { primary: '//a', fallback1: '', fallback2: '//b' } },
    });
    const xps = out.filter((l) => l.kind === 'xpath');
    expect(xps.map((x) => x.value)).toEqual(['//a', '//b']);
  });

  it('skips xpath locators entirely when shadowDOM is truthy', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      shadowDOM: true,
      metadata: {},
      selectors: { xpath: { primary: '//a', fallback1: '//b', fallback2: '//c' } },
    });
    expect(out.filter((l) => l.kind === 'xpath')).toHaveLength(0);
  });

  it('still emits css for a shadowDOM element even though xpath is skipped', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      shadowDOM: true,
      metadata: {},
      selectors: {
        css: { selector: '.s', tier: 5 },
        xpath: { primary: '//a' },
      },
    });
    expect(byKind(out, 'css')).toBeTruthy();
    expect(byKind(out, 'xpath')).toBeUndefined();
  });
});

describe('projectLocators — ranking order (the AI grounding boundary)', () => {
  it('produces the full canonical priority order testId > role > label > placeholder > text > css > xpath', () => {
    // A non-form element cannot produce label; a form field cannot produce text.
    // Build TWO elements to cover the whole ladder, then assert each ordering.

    // Form field: testId, role+name, label, placeholder, css, xpath
    const formField = projectLocators({
      tagName: 'input',
      name: 'Email',
      label: 'Email',
      metadata: {
        type: 'email',
        placeholder: 'you@example.com',
        dataAttributes: { 'data-testid': 'email-field' },
      },
      selectors: {
        css: { selector: 'input#email', tier: 1 },
        xpath: { primary: '//input[@id="email"]' },
      },
    });
    expect(kindsOf(formField)).toEqual([
      'testId',
      'role',
      'label',
      'placeholder',
      'css',
      'xpath',
    ]);
    // Strictly ascending priorities.
    const prios = formField.map((l) => l.priority);
    expect([...prios].sort((a, b) => a - b)).toEqual(prios);

    // Non-form element: testId, role+name, text, css, xpath
    const nonForm = projectLocators({
      tagName: 'a',
      name: 'Read more',
      label: 'Read more',
      metadata: { dataAttributes: { 'data-testid': 'more-link' } },
      selectors: {
        css: { selector: 'a.more', tier: 3 },
        xpath: { primary: '//a[@class="more"]' },
      },
    });
    expect(kindsOf(nonForm)).toEqual(['testId', 'role', 'text', 'css', 'xpath']);
  });

  it('sorts strictly by ascending priority even when signals are declared out of natural order', () => {
    const out = projectLocators(el({ tagName: 'a', name: 'Home', label: 'Home', selectors: { css: { selector: 'a' }, xpath: { primary: '//a' } } }));
    for (let i = 1; i < out.length; i++) {
      expect(out[i].priority).toBeGreaterThanOrEqual(out[i - 1].priority);
    }
  });

  it('role+name (2) outranks role-only (3): named element gets a single priority-2 role locator', () => {
    const out = projectLocators(el({ tagName: 'button', name: 'Save', label: 'Save' }));
    const roles = out.filter((l) => l.kind === 'role');
    expect(roles).toHaveLength(1);
    expect(roles[0].priority).toBe(2);
  });
});

describe('projectLocators — escaping in generated code', () => {
  it("escapes single quotes in getByTestId values", () => {
    const out = projectLocators(
      el({ metadata: { dataAttributes: { 'data-testid': "it's-a-test" } } })
    );
    expect(byKind(out, 'testId').code).toBe("page.getByTestId('it\\'s-a-test')");
  });

  it('escapes backslashes in css values', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: { css: { selector: '.a\\:b' } },
    });
    expect(byKind(out, 'css').code).toBe("page.locator('.a\\\\:b')");
  });

  it('escapes quotes/backslashes inside the role+name code', () => {
    const out = projectLocators(el({ tagName: 'button', name: "O'Brien", label: "O'Brien" }));
    expect(byKind(out, 'role').code).toBe("page.getByRole('button', { name: 'O\\'Brien' })");
  });

  it('escapes single quotes within an xpath value in the generated locator code', () => {
    const out = projectLocators({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: { xpath: { primary: "//div[@title='hi']" } },
    });
    expect(byKind(out, 'xpath').code).toBe("page.locator('xpath=//div[@title=\\'hi\\']')");
  });
});

describe('recommendedLocator', () => {
  it('returns the highest-priority locator (testId beats everything else)', () => {
    const rec = recommendedLocator(
      el({
        tagName: 'input',
        name: 'Email',
        label: 'Email',
        metadata: {
          type: 'email',
          placeholder: 'you@x.com',
          dataAttributes: { 'data-testid': 'email-field' },
        },
        selectors: { css: { selector: 'input#email' }, xpath: { primary: '//input' } },
      })
    );
    expect(rec.kind).toBe('testId');
    expect(rec.priority).toBe(1);
  });

  it('returns role+name when there is no testId', () => {
    const rec = recommendedLocator(el({ tagName: 'button', name: 'Save', label: 'Save' }));
    expect(rec.kind).toBe('role');
    expect(rec.priority).toBe(2);
  });

  it('returns the css fallback when only css/xpath are available', () => {
    const rec = recommendedLocator({
      tagName: 'div',
      name: '',
      label: '',
      metadata: {},
      selectors: { css: { selector: '.only' }, xpath: { primary: '//div' } },
    });
    expect(rec.kind).toBe('css');
  });

  it('returns null when no locator can be projected', () => {
    expect(recommendedLocator({ metadata: {}, selectors: {} })).toBeNull();
  });

  it('returns null for null/undefined/non-object inputs', () => {
    expect(recommendedLocator(null)).toBeNull();
    expect(recommendedLocator(undefined)).toBeNull();
    expect(recommendedLocator('x')).toBeNull();
  });

  it('matches projectLocators()[0]', () => {
    const fixture = el({
      tagName: 'a',
      name: 'Home',
      label: 'Home',
      selectors: { css: { selector: 'a.home' } },
    });
    expect(recommendedLocator(fixture)).toEqual(projectLocators(fixture)[0]);
  });
});
