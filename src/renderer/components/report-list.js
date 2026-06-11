'use strict';

import { getState, subscribe } from '../state.js';
import { hostFromUrl, lastPathSegment } from '../utils/report-metadata.js';
import { relativeTime } from '../utils/time.js';
import { iconTrash2 } from '../utils/icons.js';
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

function svgSpan(markup, cls) {
  const span = _el('span', cls);
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = markup;
  return span;
}

// Sidebar list of stored reports. Click a card → open it in the main pane.
// Per-card actions: export JSON, export CSV, delete. Presentation-only —
// handlers are injected.
export function createReportList(host, emptyEl, { onSelect, onExport, onDelete }) {
  if (!host) {
    return;
  }

  // Only rebuild the list when its inputs actually change — the global state
  // subscription also fires on every live-capture tick during a recording, and
  // rebuilding every card on each tick is wasteful.
  let _lastReports = null;
  let _lastSelected = null;

  function render(state) {
    const reports = state.reports ?? [];
    if (reports === _lastReports && state.selectedReportId === _lastSelected) {
      return;
    }
    _lastReports = reports;
    _lastSelected = state.selectedReportId;

    host.replaceChildren();

    if (emptyEl) {
      emptyEl.hidden = reports.length > 0;
    }
    if (reports.length === 0) {
      return;
    }

    // Newest first; R-number counts down so the newest has the highest index.
    reports.forEach((report, i) => {
      const displayIndex = reports.length - i;
      const card = _el('div', 'report-card');
      card.dataset.reportId = report.id;
      card.setAttribute('role', 'listitem');
      card.setAttribute('tabindex', '0');
      if (report.id === state.selectedReportId) {
        card.classList.add('report-card--baseline');
      }

      const host_ = hostFromUrl(report.url) || report.url || '(no url)';
      const path = lastPathSegment(report.url);
      card.setAttribute('aria-label', `Report ${displayIndex}: ${host_}, ${report.totalElements ?? 0} elements`);
      card.title = report.url || '';

      const leading = _el('div', 'report-card-leading');
      leading.appendChild(_el('span', 'report-card-index report-card-index--lead', `R${displayIndex}`));
      card.appendChild(leading);

      const body = _el('div', 'report-card-body');
      body.style.cursor = 'pointer';

      const line1 = _el('div', 'report-card-line report-card-line--primary');
      line1.appendChild(_el('span', 'report-card-host', host_));
      const chip = _el('span', 'report-card-chip', modeLabel(report.mode));
      line1.appendChild(chip);
      body.appendChild(line1);

      const line2 = _el('div', 'report-card-line report-card-line--meta');
      if (path) {
        line2.appendChild(_el('span', 'meta-path', path));
        line2.appendChild(_el('span', 'meta-sep', '·'));
      }
      line2.appendChild(_el('span', '', `${report.totalElements ?? 0} el`));
      const dateStr = relativeTime(report.timestamp);
      if (dateStr) {
        line2.appendChild(_el('span', 'meta-sep', '·'));
        line2.appendChild(_el('span', 'report-card-timestamp', dateStr));
      }
      body.appendChild(line2);

      body.addEventListener('click', () => onSelect?.(report.id));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(report.id);
        }
      });
      card.appendChild(body);

      const actions = _el('div', 'report-card-actions');

      const exportBtn = createExportButton({
        title: 'Export report',
        onExport: (format) => onExport?.(report, format),
      });

      const delBtn = _el('button', 'btn-icon-ghost btn-sm');
      delBtn.type = 'button';
      delBtn.title = 'Delete report';
      delBtn.setAttribute('aria-label', 'Delete report');
      delBtn.appendChild(svgSpan(iconTrash2(13)));
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete?.(report);
      });

      actions.append(exportBtn, delBtn);
      card.appendChild(actions);

      host.appendChild(card);
    });
  }

  subscribe(render);
  render(getState());
}
