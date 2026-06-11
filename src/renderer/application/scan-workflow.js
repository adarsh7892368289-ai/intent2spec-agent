'use strict';

import storage from '../infrastructure/idb-repository.js';
import { dispatch, getState, TRACKING_MODES } from '../state.js';
import { createReport, selectReport } from './report-manager.js';
import { Toast } from '../components/toast.js';

const api = window.elementTrackerAPI;

function makeOperationId() {
  return `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function browserDescriptor(state) {
  return state.selectedBrowser
    ? {
        browserType: state.selectedBrowser.browserType,
        channel: state.selectedBrowser.channel ?? null,
        executablePath: state.selectedBrowser.executablePath ?? null,
      }
    : 'chromium';
}

// Run an automated Element Scan: navigate + inject + scanPage in a headless
// Playwright browser, then store the result as a new report and open it.
export async function runScan({ url, filters }) {
  const state = getState();
  if (state.scanPhase === 'scanning') {
    return;
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    dispatch('SCAN_ERROR', { error: 'Enter a valid http(s) URL' });
    return;
  }

  const operationId = makeOperationId();
  dispatch('SCAN_STARTED', { label: 'Starting…', pct: 0, operationId });

  const profiles = await storage.getAllProfiles();
  const normalizedFilters = (filters ?? []).map((f) => String(f).trim()).filter(Boolean);

  try {
    const res = await api.scanPage({
      url,
      filters: normalizedFilters.length ? normalizedFilters : null,
      mode: TRACKING_MODES.FULL_PAGE,
      settings: state.settings,
      profiles,
      browser: browserDescriptor(state),
      operationId,
    });

    if (!res?.success) {
      if (res?.cancelled) {
        dispatch('SCAN_RESET');
        Toast.info('Scan cancelled');
        return;
      }
      dispatch('SCAN_ERROR', { error: res?.error ?? 'Scan failed' });
      Toast.error('Scan failed', res?.error ?? undefined);
      return;
    }

    const result = res.result ?? {};
    const elements = result.scan?.elements ?? [];
    if (result.profiles) {
      await storage.mergeProfiles(result.profiles);
    }

    const report = await createReport({
      mode: TRACKING_MODES.FULL_PAGE,
      url,
      engine: result.engine ?? null,
      elements,
      source: 'scan',
    });

    dispatch('SCAN_DONE');
    Toast.success(`Scanned ${elements.length} element${elements.length === 1 ? '' : 's'}`);
    await selectReport(report.id);
  } catch (err) {
    dispatch('SCAN_ERROR', { error: err?.message ?? String(err) });
    Toast.error('Scan failed', err?.message);
  }
}

export async function cancelScan() {
  const { operationId } = getState();
  if (operationId && api.cancelOperation) {
    await api.cancelOperation({ operationId });
  }
}
