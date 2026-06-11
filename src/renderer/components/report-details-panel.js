'use strict';

import { hostFromUrl } from '../utils/report-metadata.js';
import { absoluteCalendarDate } from '../utils/time.js';
import { iconX } from '../utils/icons.js';
import { modeLabel } from '../application/report-manager.js';
import { createExportButton } from './export-menu.js';

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

function _platform(engine) {
  return engine ? String(engine) : '—';
}

// Renders a selected report into the main pane: a metadata header plus a
// scrollable table of captured elements with their selectors. Stateless view —
// call render(report, elements) / clear().
export function createReportDetailsPanel(host, { onClose, onExport }) {
  function clear() {
    host.replaceChildren();
    host.hidden = true;
  }

  function renderEmpty(message) {
    host.hidden = false;
    host.replaceChildren();
    const empty = _el('div', 'report-details__empty');
    empty.appendChild(_el('p', 'empty-title', message ?? 'Select a report'));
    host.appendChild(empty);
  }

  function render(report, elements) {
    if (!report) {
      clear();
      return;
    }
    host.hidden = false;
    host.replaceChildren();

    // ---- header ----
    const header = _el('div', 'report-details__header');

    const titleWrap = _el('div', 'report-details__title-wrap');
    titleWrap.appendChild(_el('h2', 'report-details__title', hostFromUrl(report.url) || report.url || 'Report'));
    const sub = _el('div', 'report-details__subtitle');
    sub.textContent = report.url || '';
    titleWrap.appendChild(sub);
    header.appendChild(titleWrap);

    const headerActions = _el('div', 'report-details__header-actions');
    headerActions.appendChild(
      createExportButton({
        withLabel: true,
        title: 'Export report',
        onExport: (format) => onExport?.(report, format),
      })
    );
    const closeBtn = _el('button', 'btn-icon-ghost btn-sm');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close report');
    closeBtn.innerHTML = iconX(14);
    closeBtn.addEventListener('click', () => onClose?.());
    headerActions.append(closeBtn);
    header.appendChild(headerActions);
    host.appendChild(header);

    // ---- meta chips ----
    const meta = _el('div', 'report-details__meta');
    const chips = [
      ['Mode', modeLabel(report.mode)],
      ['Elements', String(report.totalElements ?? elements?.length ?? 0)],
      ['Browser', _platform(report.engine)],
      ['Captured', absoluteCalendarDate(report.timestamp) || ''],
    ];
    for (const [label, value] of chips) {
      const chip = _el('div', 'report-details__meta-chip');
      chip.appendChild(_el('span', 'report-details__meta-label', label));
      chip.appendChild(_el('span', 'report-details__meta-value', value));
      meta.appendChild(chip);
    }
    host.appendChild(meta);

    // ---- element table ----
    const list = Array.isArray(elements) ? elements : [];
    if (list.length === 0) {
      const empty = _el('p', 'field-hint', 'No captured elements in this report.');
      host.appendChild(empty);
      return;
    }

    const tableWrap = _el('div', 'report-details__table-wrap');
    const table = _el('table', 'report-details__table');

    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    for (const h of ['#', 'Type', 'Name', 'Tag', 'Primary XPath', 'CSS Selector']) {
      hrow.appendChild(_el('th', null, h));
    }
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    list.forEach((item, i) => {
      const tr = document.createElement('tr');
      const xpath = item.selectors?.xpath?.primary ?? '';
      const css = item.selectors?.css?.selector ?? '';
      const cells = [
        String(i + 1),
        item.captureType ?? 'scan',
        item.name ?? '',
        item.tagName ?? item.metadata?.tag ?? '',
        xpath,
        css,
      ];
      cells.forEach((c, idx) => {
        const td = _el('td', idx >= 4 ? 'report-details__cell-mono' : null, c);
        td.title = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    host.appendChild(tableWrap);
  }

  return { render, renderEmpty, clear };
}
