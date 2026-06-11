'use strict';

import { iconFileDown, iconChevronDown } from '../utils/icons.js';

// A single download button that opens a dropdown of export formats. Reused in
// the sidebar report cards and the report-details header. Self-contained: one
// menu open at a time, closes on outside-click / Escape / selection.

const EXPORT_OPTIONS = [
  { format: 'json', label: 'JSON', hint: 'Raw captured data' },
  { format: 'csv', label: 'CSV', hint: 'Selectors table' },
  { format: 'playwright', label: 'Playwright', hint: 'Runnable .spec.js' },
  { format: 'automation', label: 'Automation', hint: 'NLP-ready locators + steps' },
];

let _openMenu = null;

function _closeOpenMenu() {
  if (_openMenu) {
    _openMenu.remove();
    _openMenu = null;
    document.removeEventListener('click', _onDocClick, true);
    document.removeEventListener('keydown', _onKeydown, true);
  }
}

function _onDocClick(e) {
  if (_openMenu && !_openMenu.contains(e.target) && !_openMenu._anchor?.contains(e.target)) {
    _closeOpenMenu();
  }
}

function _onKeydown(e) {
  if (e.key === 'Escape') {
    _closeOpenMenu();
  }
}

function _svg(markup) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = markup;
  return span;
}

// Build the download trigger button. `opts.withLabel` shows a chevron + adapts
// to header (ghost button) vs card (icon-only) styling. `onExport(format)` fires
// when an item is chosen.
export function createExportButton({ withLabel = false, onExport, title = 'Export' } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = withLabel ? 'btn-ghost btn-sm export-menu__trigger' : 'btn-icon-ghost btn-sm export-menu__trigger';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(_svg(iconFileDown(withLabel ? 13 : 14)));
  if (withLabel) {
    const lbl = document.createElement('span');
    lbl.className = 'btn-label';
    lbl.textContent = 'Export';
    btn.appendChild(lbl);
    btn.appendChild(_svg(iconChevronDown(11)));
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_openMenu && _openMenu._anchor === btn) {
      _closeOpenMenu();
      btn.setAttribute('aria-expanded', 'false');
      return;
    }
    _closeOpenMenu();
    _openMenuFor(btn, onExport);
  });

  return btn;
}

function _openMenuFor(anchor, onExport) {
  const menu = document.createElement('div');
  menu.className = 'export-menu report-card-overflow-menu--portal';
  menu.setAttribute('role', 'menu');
  menu._anchor = anchor;

  const groupLabel = document.createElement('div');
  groupLabel.className = 'report-card-overflow-menu__group-label';
  groupLabel.textContent = 'Export as';
  menu.appendChild(groupLabel);

  for (const opt of EXPORT_OPTIONS) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'report-card-overflow-menu__item export-menu__item';
    item.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.className = 'export-menu__item-label';
    label.textContent = opt.label;
    const hint = document.createElement('span');
    hint.className = 'export-menu__item-hint';
    hint.textContent = opt.hint;
    item.append(label, hint);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      _closeOpenMenu();
      anchor.setAttribute('aria-expanded', 'false');
      onExport?.(opt.format);
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  _openMenu = menu;
  anchor.setAttribute('aria-expanded', 'true');

  // Position below the anchor, flipping above / shifting left to stay on-screen.
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 4;
  let top = rect.bottom + gap;
  let placement = 'below';
  if (top + menuRect.height > window.innerHeight && rect.top - menuRect.height - gap > 0) {
    top = rect.top - menuRect.height - gap;
    placement = 'above';
  }
  let left = rect.right - menuRect.width;
  if (left < gap) {
    left = Math.min(rect.left, window.innerWidth - menuRect.width - gap);
  }
  menu.style.top = `${Math.max(gap, Math.round(top))}px`;
  menu.style.left = `${Math.max(gap, Math.round(left))}px`;
  menu.dataset.placement = placement;

  // Defer listener attach so the opening click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', _onDocClick, true);
    document.addEventListener('keydown', _onKeydown, true);
  }, 0);
}
