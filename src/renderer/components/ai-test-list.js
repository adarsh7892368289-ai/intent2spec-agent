'use strict';

import { getState, subscribe } from '../state.js';
import { hostFromUrl } from '../utils/report-metadata.js';
import { relativeTime } from '../utils/time.js';
import { iconTrash2 } from '../utils/icons.js';

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

function svgSpan(markup) {
  const span = _el('span');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = markup;
  return span;
}

// Sidebar list of stored AI tests. Mirrors report-list: click a card → open it
// in the main pane; per-card delete. Memoized on the inputs it renders from.
export function createAiTestList(host, emptyEl, { onSelect, onDelete }) {
  if (!host) {
    return;
  }
  let _last = null;
  let _lastSel = null;

  function render(state) {
    const tests = state.aiTests ?? [];
    if (tests === _last && state.selectedAiTestId === _lastSel) {
      return;
    }
    _last = tests;
    _lastSel = state.selectedAiTestId;

    host.replaceChildren();
    if (emptyEl) {
      emptyEl.hidden = tests.length > 0;
    }
    if (tests.length === 0) {
      return;
    }

    tests.forEach((t, i) => {
      const displayIndex = tests.length - i;
      const card = _el('div', 'report-card');
      card.dataset.aiTestId = t.id;
      card.setAttribute('role', 'listitem');
      card.setAttribute('tabindex', '0');
      if (t.id === state.selectedAiTestId) {
        card.classList.add('report-card--baseline');
      }

      const hostName = hostFromUrl(t.startUrl) || t.startUrl || '(no url)';
      card.setAttribute('aria-label', `AI test ${displayIndex}: ${hostName}`);
      card.title = t.startUrl || '';

      const leading = _el('div', 'report-card-leading');
      leading.appendChild(_el('span', 'report-card-index report-card-index--lead', `T${displayIndex}`));
      card.appendChild(leading);

      const body = _el('div', 'report-card-body');
      body.style.cursor = 'pointer';

      const line1 = _el('div', 'report-card-line report-card-line--primary');
      line1.appendChild(_el('span', 'report-card-host', hostName));
      const chip = _el('span', `report-card-chip ai-test-chip--${t.success ? 'pass' : 'fail'}`, t.success ? 'pass' : 'ended');
      line1.appendChild(chip);
      body.appendChild(line1);

      const line2 = _el('div', 'report-card-line report-card-line--meta');
      // first line of the English steps as a preview
      const firstStep = (t.stepsText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'AI test';
      line2.appendChild(_el('span', 'meta-path', firstStep.slice(0, 48)));
      const dateStr = relativeTime(t.timestamp);
      if (dateStr) {
        line2.appendChild(_el('span', 'meta-sep', '·'));
        line2.appendChild(_el('span', 'report-card-timestamp', dateStr));
      }
      body.appendChild(line2);

      body.addEventListener('click', () => onSelect?.(t.id));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(t.id);
        }
      });
      card.appendChild(body);

      const actions = _el('div', 'report-card-actions');
      const delBtn = _el('button', 'btn-icon-ghost btn-sm');
      delBtn.type = 'button';
      delBtn.title = 'Delete AI test';
      delBtn.setAttribute('aria-label', 'Delete AI test');
      delBtn.appendChild(svgSpan(iconTrash2(13)));
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete?.(t);
      });
      actions.appendChild(delBtn);
      card.appendChild(actions);

      host.appendChild(card);
    });
  }

  subscribe(render);
  render(getState());
}
