// =============================================================================
// Locator Projection: enriched element  ->  ranked Playwright locators
//
// The capture engine already produces validated, ranked XPath + CSS
// selectors plus accessibility metadata (role, name, label, test ids, …). This
// module projects that onto Playwright's *recommended* locator priority so the
// future NLP→automation layer can pick a known-good locator instead of inventing
// one. Pure & DOM-free: operates only on the serialized enriched-element object,
// so it runs in the page bundle, the renderer, or Node alike.
//
// Playwright's recommended priority (https://playwright.dev/docs/locators):
//   getByTestId > getByRole(name) > getByLabel > getByPlaceholder >
//   getByText > getByAltText > getByTitle > css= > xpath=
// =============================================================================

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];

// ARIA role inferred from tag when no explicit role attribute is present —
// mirrors the subset Playwright's getByRole resolves most reliably.
const IMPLICIT_ROLE = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  nav: 'navigation',
  table: 'table',
};

const INPUT_TYPE_ROLE = {
  checkbox: 'checkbox',
  radio: 'radio',
  button: 'button',
  submit: 'button',
  reset: 'button',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  text: 'textbox',
  password: 'textbox',
};

function _str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function _quote(v) {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function _meta(el) {
  return el && typeof el.metadata === 'object' && el.metadata ? el.metadata : {};
}

// The element's accessible name, preferring the engine's label extraction.
export function accessibleName(el) {
  const name = _str(el?.name);
  const label = _str(el?.label);
  return name && name !== 'Unknown' && name !== 'Unknown Element' ? name : label;
}

// The element's ARIA role: explicit role attr, else implicit from tag/type.
export function inferRole(el) {
  const meta = _meta(el);
  const aria = meta.ariaAttributes || {};
  const explicit = _str(aria.role) || _str(meta.role);
  if (explicit) {
    return explicit;
  }
  const tag = _str(el?.tagName || meta.tag).toLowerCase();
  if (tag === 'input') {
    const type = _str(meta.type).toLowerCase() || 'text';
    return INPUT_TYPE_ROLE[type] ?? 'textbox';
  }
  return IMPLICIT_ROLE[tag] ?? null;
}

function _testId(el) {
  const meta = _meta(el);
  const data = meta.dataAttributes || {};
  for (const attr of TEST_ID_ATTRS) {
    // dataAttributes are keyed by full attr name OR camelCase dataset key — check both.
    const dashVal = _str(data[attr]);
    if (dashVal) {
      return { attr, value: dashVal };
    }
    const dsKey = attr.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const dsVal = _str(data[dsKey]);
    if (dsVal) {
      return { attr, value: dsVal };
    }
  }
  return null;
}

// Build the ranked locator list for one enriched element. Each entry:
//   { kind, code, value, role?, name?, priority, source }
// `code` is ready-to-use Playwright JS (e.g. `page.getByRole('button', { name: 'Save' })`).
export function projectLocators(el) {
  if (!el || typeof el !== 'object') {
    return [];
  }
  const out = [];
  const meta = _meta(el);
  const name = accessibleName(el);
  const role = inferRole(el);

  // 1) getByTestId — most stable.
  const tid = _testId(el);
  if (tid) {
    out.push({
      kind: 'testId',
      priority: 1,
      value: tid.value,
      attr: tid.attr,
      code: `page.getByTestId(${_quote(tid.value)})`,
      source: 'data-attribute',
    });
  }

  // 2) getByRole(role, { name }) — semantic + accessible.
  if (role && name) {
    out.push({
      kind: 'role',
      priority: 2,
      role,
      name,
      code: `page.getByRole(${_quote(role)}, { name: ${_quote(name)} })`,
      source: 'aria/label',
    });
  } else if (role) {
    out.push({
      kind: 'role',
      priority: 3,
      role,
      code: `page.getByRole(${_quote(role)})`,
      source: 'aria/tag',
    });
  }

  // 3) getByLabel — form controls associated with a <label>.
  const tag = _str(el?.tagName || meta.tag).toLowerCase();
  const isFormField = tag === 'input' || tag === 'select' || tag === 'textarea';
  if (isFormField && name) {
    out.push({
      kind: 'label',
      priority: 4,
      value: name,
      code: `page.getByLabel(${_quote(name)})`,
      source: 'label',
    });
  }

  // 4) getByPlaceholder.
  const placeholder = _str(meta.placeholder);
  if (placeholder) {
    out.push({
      kind: 'placeholder',
      priority: 5,
      value: placeholder,
      code: `page.getByPlaceholder(${_quote(placeholder)})`,
      source: 'placeholder',
    });
  }

  // 5) getByText — non-form elements with a stable visible name.
  if (!isFormField && name && name.length <= 80) {
    out.push({
      kind: 'text',
      priority: 6,
      value: name,
      code: `page.getByText(${_quote(name)}, { exact: true })`,
      source: 'text',
    });
  }

  // 6) CSS fallback (validated by the engine).
  const css = _str(el?.selectors?.css?.selector);
  if (css) {
    out.push({
      kind: 'css',
      priority: 7,
      value: css,
      code: `page.locator(${_quote(css)})`,
      source: 'css-engine',
      robustness: el.selectors.css.tier ?? null,
    });
  }

  // 7) XPath fallback + the engine's diverse alternates (last resort, but validated).
  const xp = el?.selectors?.xpath;
  if (xp && !el.shadowDOM) {
    for (const key of ['primary', 'fallback1', 'fallback2']) {
      const val = _str(xp[key]);
      if (val) {
        out.push({
          kind: 'xpath',
          priority: 8,
          value: val,
          code: `page.locator('xpath=${val.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`,
          source: `xpath-engine:${key}`,
          robustness: xp.robustness ?? null,
        });
      }
    }
  }

  out.sort((a, b) => a.priority - b.priority);
  return out;
}

// The single best locator for an element (or null if none could be projected).
export function recommendedLocator(el) {
  return projectLocators(el)[0] ?? null;
}
