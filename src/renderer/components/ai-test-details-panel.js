'use strict';

import { hostFromUrl } from '../utils/report-metadata.js';
import { absoluteCalendarDate } from '../utils/time.js';
import { iconX, iconFileDown } from '../utils/icons.js';

function _el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// Renders a stored AI test into the main pane: metadata, the user's English
// steps, the generated Playwright spec, and the run transcript. Stateless view.
export function createAiTestDetailsPanel(host, { onClose, onExport }) {
  function clear() {
    host.replaceChildren();
    host.hidden = true;
  }

  function render(test) {
    if (!test) {
      clear();
      return;
    }
    host.hidden = false;
    host.replaceChildren();

    // ---- header ----
    const header = _el('div', 'report-details__header');
    const titleWrap = _el('div', 'report-details__title-wrap');
    titleWrap.appendChild(_el('h2', 'report-details__title', hostFromUrl(test.startUrl) || test.startUrl || 'AI Test'));
    const sub = _el('div', 'report-details__subtitle');
    sub.textContent = test.startUrl || '';
    titleWrap.appendChild(sub);
    header.appendChild(titleWrap);

    const actions = _el('div', 'report-details__header-actions');
    if (test.spec) {
      const exp = _el('button', 'btn-ghost btn-sm');
      exp.type = 'button';
      exp.innerHTML = `${iconFileDown(13)} Export .spec`;
      exp.addEventListener('click', () => onExport?.(test));
      actions.appendChild(exp);
    }
    const closeBtn = _el('button', 'btn-icon-ghost btn-sm');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = iconX(14);
    closeBtn.addEventListener('click', () => onClose?.());
    actions.appendChild(closeBtn);
    header.appendChild(actions);
    host.appendChild(header);

    // ---- meta chips ----
    const meta = _el('div', 'report-details__meta');
    const chips = [
      ['Status', test.success ? 'Passed' : 'Ended'],
      ['Browser', test.browserType || '—'],
      ['Grounding', test.reportLabel || 'live discovery'],
      ['Duration', test.durationMs ? `${Math.round(test.durationMs / 100) / 10}s` : '—'],
      ['Generated', absoluteCalendarDate(test.timestamp) || ''],
    ];
    if (test.costUsd != null) {
      chips.push(['Cost', `$${test.costUsd.toFixed(4)}`]);
    }
    for (const [label, value] of chips) {
      const chip = _el('div', 'report-details__meta-chip');
      chip.appendChild(_el('span', 'report-details__meta-label', label));
      chip.appendChild(_el('span', 'report-details__meta-value', value));
      meta.appendChild(chip);
    }
    host.appendChild(meta);

    // ---- English steps ----
    host.appendChild(_el('h3', 'ai-detail__section-title', 'Instructions (plain English)'));
    const steps = _el('pre', 'ai-detail__steps');
    steps.textContent = test.stepsText || '(none recorded)';
    host.appendChild(steps);

    // ---- generated spec ----
    host.appendChild(_el('h3', 'ai-detail__section-title', 'Generated Playwright test'));
    const spec = _el('pre', 'ai-spec');
    spec.appendChild(_el('code', null, test.spec || '(no spec was written)'));
    host.appendChild(spec);

    // ---- run transcript ----
    if (Array.isArray(test.transcript) && test.transcript.length) {
      host.appendChild(_el('h3', 'ai-detail__section-title', 'Run log'));
      const log = _el('div', 'ai-stream__log');
      for (const line of test.transcript) {
        log.appendChild(_el('div', 'ai-stream__row', line));
      }
      host.appendChild(log);
    }
  }

  return { render, clear };
}
