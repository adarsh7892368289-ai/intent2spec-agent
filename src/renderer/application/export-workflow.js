'use strict';

import { getElementsForMode } from './data-manager.js';
import { TRACKING_MODES } from '../state.js';
import { Toast } from '../components/toast.js';

const api = window.elementTrackerAPI;

const MODE_FILENAME = {
  [TRACKING_MODES.INTERACTIONS]: 'interactions',
  [TRACKING_MODES.FULL_PAGE]: 'elements',
  [TRACKING_MODES.HYBRID]: 'hybrid',
};

// CSV event types that carry click/input event data (interactions schema).
const INTERACTION_CSV_TYPES = ['input', 'click'];

// Export a mode's captured elements as JSON or CSV via the save-dialog IPC.
export async function exportMode(mode, format) {
  let elements;
  try {
    elements = await getElementsForMode(mode);
  } catch (err) {
    Toast.error('Export failed', err?.message);
    return;
  }

  if (!Array.isArray(elements) || elements.length === 0) {
    Toast.warning('Nothing to export', 'No captured data for this mode.');
    return;
  }

  const base = MODE_FILENAME[mode] ?? 'export';
  let content;
  let filename;

  if (format === 'csv') {
    const hasInteractions = mode === TRACKING_MODES.INTERACTIONS || mode === TRACKING_MODES.HYBRID;
    content = hasInteractions ? interactionsToCSV(elements) : elementsToCSV(elements);
    if (!content) {
      content = elementsToCSV(elements);
    }
    if (!content) {
      Toast.warning('Nothing to export', 'No exportable rows for CSV.');
      return;
    }
    filename = `${base}.csv`;
  } else {
    content = JSON.stringify(elements, null, 2);
    filename = `${base}.json`;
  }

  try {
    const res = await api.exportFile({ content, filename, format: format === 'csv' ? 'csv' : 'json' });
    if (res?.success) {
      Toast.success(`Exported ${elements.length} element${elements.length === 1 ? '' : 's'}`);
    } else if (res?.reason !== 'cancelled') {
      Toast.error('Export failed', res?.error ?? undefined);
    }
  } catch (err) {
    Toast.error('Export failed', err?.message);
  }
}

// ---- CSV serialization (ported from popup/export-manager.js) ----------------

function escapeCSV(value) {
  if (value === null || value === undefined) {
    return '""';
  }
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

function formatContext(contextArray, index) {
  if (!Array.isArray(contextArray) || !contextArray[index]) {
    return '""';
  }
  const ctx = contextArray[index];
  const formatted = `${ctx.element || ''} - ${ctx.label || ''} (${ctx.direction || ''}, ${ctx.distance || 0}px)`;
  return escapeCSV(formatted);
}

function buildDomPath(parents) {
  if (!Array.isArray(parents) || parents.length === 0) {
    return '';
  }
  return parents.map((p) => p.tag || 'unknown').join(' > ');
}

function formatInputValue(item) {
  if (item.captureType !== 'input') {
    return '""';
  }
  const inputData = item.eventData?.input;
  if (!inputData) {
    return '""';
  }
  if (inputData.inputType === 'checkbox' || inputData.inputType === 'radio') {
    return escapeCSV(inputData.checked ? 'checked' : 'unchecked');
  }
  if (inputData.inputType === 'password') {
    return escapeCSV('***');
  }
  return escapeCSV(inputData.value || '');
}

function formatClickCoordinates(item) {
  if (item.captureType !== 'click') {
    return '""';
  }
  const clickData = item.eventData?.click;
  if (!clickData) {
    return '""';
  }
  return escapeCSV(`x:${clickData.clientX ?? clickData.x}, y:${clickData.clientY ?? clickData.y}`);
}

function interactionsToCSV(data) {
  const items = (Array.isArray(data) ? data : []).filter((item) =>
    INTERACTION_CSV_TYPES.includes(item.captureType)
  );
  if (items.length === 0) {
    return '';
  }

  const headers = [
    'Page Title',
    'Interaction Type',
    'Element Name',
    'Tag Name',
    'Primary XPath',
    'XPath Fallback 1',
    'XPath Fallback 2',
    'CSS Selector',
    'Click Coordinates',
    'Context 1',
    'Context 2',
    'Context 3',
    'Context 4',
    'URL',
    'Full DOM Path',
    'Timestamp',
    'Input Value',
  ];

  const rows = [headers.join(',')];
  for (const item of items) {
    const xpathSel = item.selectors?.xpath;
    const cssSel = item.selectors?.css;
    rows.push(
      [
        escapeCSV(item.pageTitle || ''),
        escapeCSV(item.captureType || ''),
        escapeCSV(item.name || ''),
        escapeCSV(item.tagName || item.metadata?.tag || ''),
        escapeCSV(xpathSel?.primary || ''),
        escapeCSV(xpathSel?.fallback1 || ''),
        escapeCSV(xpathSel?.fallback2 || ''),
        escapeCSV(cssSel?.selector || ''),
        formatClickCoordinates(item),
        formatContext(item.context, 0),
        formatContext(item.context, 1),
        formatContext(item.context, 2),
        formatContext(item.context, 3),
        escapeCSV(item.url || ''),
        escapeCSV(buildDomPath(item.hierarchy?.parents)),
        escapeCSV(item.timestamp || ''),
        formatInputValue(item),
      ].join(',')
    );
  }
  return rows.join('\n');
}

function elementsToCSV(data) {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    return '';
  }

  const headers = [
    'Page Title',
    'Element Name',
    'Tag Name',
    'Primary XPath',
    'XPath Fallback 1',
    'XPath Fallback 2',
    'CSS Selector',
    'Context 1',
    'Context 2',
    'Context 3',
    'Context 4',
    'URL',
    'Full DOM Path',
  ];

  const rows = [headers.join(',')];
  for (const item of items) {
    const xpathSel = item.selectors?.xpath;
    const cssSel = item.selectors?.css;
    rows.push(
      [
        escapeCSV(item.pageTitle || ''),
        escapeCSV(item.name || ''),
        escapeCSV(item.tagName || item.metadata?.tag || ''),
        escapeCSV(xpathSel?.primary || ''),
        escapeCSV(xpathSel?.fallback1 || ''),
        escapeCSV(xpathSel?.fallback2 || ''),
        escapeCSV(cssSel?.selector || ''),
        formatContext(item.context, 0),
        formatContext(item.context, 1),
        formatContext(item.context, 2),
        formatContext(item.context, 3),
        escapeCSV(item.url || ''),
        escapeCSV(buildDomPath(item.hierarchy?.parents)),
      ].join(',')
    );
  }
  return rows.join('\n');
}
