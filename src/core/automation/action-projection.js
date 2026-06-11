// =============================================================================
// Action Projection: recorded interactions  ->  ordered Playwright action steps
//
// A recording is a time-ordered list of enriched interaction elements (click,
// input, form, navigation, scroll). This module turns them into structured,
// Playwright-ready steps — each carrying the recommended locator and the action
// + value — so the NLP layer can reorder / parameterize them or emit a script
// directly. Pure & DOM-free.
// =============================================================================

import { projectLocators, recommendedLocator } from './locator-projection.js';

function _quote(v) {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// Map one enriched capture to a structured action step (or null if not actionable).
export function projectStep(el, index) {
  if (!el || typeof el !== 'object') {
    return null;
  }
  const type = el.captureType;

  // Navigation — no element locator; a goto/waitForURL step.
  if (type === 'navigation') {
    const nav = el.eventData?.navigation;
    const to = nav?.to;
    if (!to) {
      return null;
    }
    return {
      index,
      action: 'navigate',
      url: to,
      method: nav?.method ?? null,
      code: `await page.goto(${_quote(to)});`,
    };
  }

  // Scroll — informational; emit a mouse wheel / scrollIntoView hint.
  if (type === 'scroll') {
    const s = el.eventData?.scroll;
    return {
      index,
      action: 'scroll',
      scrollY: s?.scrollY ?? null,
      code: s?.scrollY != null ? `await page.mouse.wheel(0, ${Math.round(s.scrollY)});` : '// scroll',
      note: 'Scrolls are usually implicit in Playwright (auto-scroll on action); kept for fidelity.',
    };
  }

  const locators = projectLocators(el);
  const best = locators[0] ?? null;
  if (!best) {
    return null;
  }
  const locatorCode = best.code;

  if (type === 'click') {
    return {
      index,
      action: 'click',
      name: el.name ?? '',
      locator: best,
      alternates: locators.slice(1),
      code: `await ${locatorCode}.click();`,
    };
  }

  if (type === 'input') {
    const input = el.eventData?.input ?? {};
    const inputType = input.inputType;
    if (inputType === 'checkbox' || inputType === 'radio') {
      const checked = input.checked === true;
      return {
        index,
        action: checked ? 'check' : 'uncheck',
        name: el.name ?? '',
        locator: best,
        alternates: locators.slice(1),
        code: `await ${locatorCode}.${checked ? 'check' : 'uncheck'}();`,
      };
    }
    if (inputType === 'password') {
      return {
        index,
        action: 'fill',
        name: el.name ?? '',
        locator: best,
        alternates: locators.slice(1),
        value: '«password»',
        secret: true,
        code: `await ${locatorCode}.fill(${_quote('«password»')}); // TODO: inject secret`,
      };
    }
    const value = input.value ?? '';
    // select-one → selectOption; otherwise fill.
    if (el.tagName === 'select') {
      return {
        index,
        action: 'selectOption',
        name: el.name ?? '',
        locator: best,
        alternates: locators.slice(1),
        value,
        code: `await ${locatorCode}.selectOption(${_quote(value)});`,
      };
    }
    return {
      index,
      action: 'fill',
      name: el.name ?? '',
      locator: best,
      alternates: locators.slice(1),
      value,
      code: `await ${locatorCode}.fill(${_quote(value)});`,
    };
  }

  if (type === 'form') {
    return {
      index,
      action: 'submit',
      name: el.name ?? '',
      locator: best,
      alternates: locators.slice(1),
      code: `await ${locatorCode}.click(); // submit`,
    };
  }

  // Element-scan rows aren't actions; expose them as a locatable target only.
  return {
    index,
    action: 'locate',
    name: el.name ?? '',
    locator: best,
    alternates: locators.slice(1),
    code: `${locatorCode}; // ${el.name ?? el.tagName ?? 'element'}`,
  };
}

// Project a whole report's elements into an ordered step list. `elements`
// should be in capture order (recordings already are).
export function projectSteps(elements) {
  if (!Array.isArray(elements)) {
    return [];
  }
  const steps = [];
  let i = 0;
  for (const el of elements) {
    const step = projectStep(el, i);
    if (step) {
      steps.push(step);
      i++;
    }
  }
  return steps;
}

// Emit a runnable Playwright test from a report's steps. Header + ordered body.
export function toPlaywrightScript(report, elements, opts = {}) {
  const steps = projectSteps(elements);
  const title = opts.title || `${report?.mode ?? 'recording'} – ${report?.host ?? report?.url ?? 'flow'}`;
  const startUrl = report?.url || (steps.find((s) => s.action === 'navigate')?.url ?? '');
  const lines = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test(${_quote(title)}, async ({ page }) => {`);
  if (startUrl) {
    lines.push(`  await page.goto(${_quote(startUrl)});`);
  }
  for (const step of steps) {
    if (step.action === 'navigate' && step.url === startUrl) {
      continue;
    }
    lines.push(`  ${step.code}`);
  }
  lines.push('});');
  return lines.join('\n');
}

// The structured payload the NLP layer consumes: the report meta, the locator
// inventory (every element + its ranked locators), and the ordered action steps.
export function buildAutomationPayload(report, elements) {
  return {
    report: report
      ? { id: report.id, mode: report.mode, url: report.url, host: report.host, timestamp: report.timestamp }
      : null,
    inventory: (Array.isArray(elements) ? elements : []).map((el) => ({
      name: el.name ?? '',
      role: el.tagName ?? el.metadata?.tag ?? '',
      captureType: el.captureType ?? 'scan',
      locators: projectLocators(el),
      recommended: recommendedLocator(el),
    })),
    steps: projectSteps(elements),
  };
}
