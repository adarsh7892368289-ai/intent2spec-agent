'use strict';

import storage from '../infrastructure/idb-repository.js';
import { dispatch, getState, DEFAULT_SETTINGS } from '../state.js';
import { hostFromUrl } from '../utils/report-metadata.js';

const MODE_LABELS = {
  interactions: 'Interactions',
  full_page: 'Element Scan',
  hybrid: 'Hybrid',
};

export function modeLabel(mode) {
  return MODE_LABELS[mode] ?? mode;
}

function makeReportId() {
  return `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Load persisted settings, reports, and storage usage into state.
export async function initializeReports() {
  const settings = (await storage.getSettings()) ?? DEFAULT_SETTINGS;
  dispatch('SETTINGS_LOADED', { settings });
  await refreshReports();
  await refreshAiTests();
  await refreshUsage();
}

export async function refreshReports() {
  const reports = await storage.getReports();
  dispatch('REPORTS_LOADED', { reports });
}

export async function refreshAiTests() {
  const aiTests = await storage.getAiTests();
  dispatch('AI_TESTS_LOADED', { aiTests });
}

export async function refreshUsage() {
  const usage = await storage.estimateUsage();
  dispatch('USAGE_LOADED', { usage });
}

export async function persistSettings() {
  await storage.saveSettings(getState().settings);
}

// Create + persist a report from a capture. `elements` is the captured element
// array; `meta` carries url/mode/engine/etc. Returns the saved report metadata.
export async function createReport({ mode, url, engine, elements, source, statBreakdown }) {
  const id = makeReportId();
  const report = {
    id,
    mode,
    url: url ?? '',
    host: hostFromUrl(url ?? ''),
    engine: engine ?? null,
    source: source ?? 'capture',
    timestamp: Date.now(),
    totalElements: Array.isArray(elements) ? elements.length : 0,
    statBreakdown: statBreakdown ?? null,
  };
  const saved = await storage.saveReport(report, elements ?? []);
  dispatch('REPORT_ADDED', { report: saved });
  await refreshUsage();
  return saved;
}

export async function selectReport(reportId) {
  dispatch('REPORT_SELECTED', { reportId });
  const elements = await storage.getReportElements(reportId);
  dispatch('REPORT_ELEMENTS_LOADED', { reportId, elements });
}

export async function deleteReport(reportId) {
  await storage.deleteReport(reportId);
  dispatch('REPORT_DELETED', { reportId });
  await refreshUsage();
}

export async function clearAllReports() {
  await storage.clearAllReports();
  dispatch('REPORTS_CLEARED');
  await refreshUsage();
}

export async function getReportElements(reportId) {
  return storage.getReportElements(reportId);
}
