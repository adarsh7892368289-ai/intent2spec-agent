'use strict';

import { getState, subscribe, TRACKING_MODES } from '../state.js';
import { iconTrash2, iconFileDown } from '../utils/icons.js';

const MODE_META = [
  { mode: TRACKING_MODES.INTERACTIONS, label: 'Interactions' },
  { mode: TRACKING_MODES.FULL_PAGE, label: 'Element Scan' },
  { mode: TRACKING_MODES.HYBRID, label: 'Hybrid' },
];

// Sidebar list: one card per tracking mode showing its element count and
// per-mode actions (export JSON/CSV, clear). Export/clear handlers are injected
// so this component stays presentation-only.
export function createCapturesList(host, { onExport, onClear, onClearAll }) {
  if (!host) {
    return;
  }

  function svg(markup) {
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = markup;
    return span;
  }

  function render(state) {
    host.replaceChildren();

    let total = 0;
    for (const { mode, label } of MODE_META) {
      const count = state.counts?.[mode] ?? 0;
      total += count;

      const card = document.createElement('div');
      card.className = 'capture-card';
      card.dataset.mode = mode;

      const head = document.createElement('div');
      head.className = 'capture-card__head';

      const name = document.createElement('span');
      name.className = 'capture-card__name';
      name.textContent = label;

      const badge = document.createElement('span');
      badge.className = 'capture-card__count';
      badge.textContent = String(count);

      head.append(name, badge);

      const actions = document.createElement('div');
      actions.className = 'capture-card__actions';

      const jsonBtn = document.createElement('button');
      jsonBtn.type = 'button';
      jsonBtn.className = 'btn-ghost btn-sm';
      jsonBtn.appendChild(svg(iconFileDown(13)));
      jsonBtn.append(' JSON');
      jsonBtn.disabled = count === 0;
      jsonBtn.addEventListener('click', () => onExport?.(mode, 'json'));

      const csvBtn = document.createElement('button');
      csvBtn.type = 'button';
      csvBtn.className = 'btn-ghost btn-sm';
      csvBtn.appendChild(svg(iconFileDown(13)));
      csvBtn.append(' CSV');
      csvBtn.disabled = count === 0;
      csvBtn.addEventListener('click', () => onExport?.(mode, 'csv'));

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn-icon-ghost btn-sm';
      clearBtn.setAttribute('aria-label', `Clear ${label} data`);
      clearBtn.appendChild(svg(iconTrash2(13)));
      clearBtn.disabled = count === 0;
      clearBtn.addEventListener('click', () => onClear?.(mode, label));

      actions.append(jsonBtn, csvBtn, clearBtn);
      card.append(head, actions);
      host.appendChild(card);
    }

    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'btn-ghost btn-sm capture-clear-all';
    clearAll.textContent = 'Clear all data';
    clearAll.disabled = total === 0;
    clearAll.addEventListener('click', () => onClearAll?.());
    host.appendChild(clearAll);
  }

  subscribe(render);
  render(getState());
}
