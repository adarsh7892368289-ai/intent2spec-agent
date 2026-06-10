'use strict';

import storage from '../infrastructure/idb-repository.js';
import { dispatch, getState, DEFAULT_SETTINGS, TRACKING_MODES } from '../state.js';

const ALL_MODES = [TRACKING_MODES.INTERACTIONS, TRACKING_MODES.FULL_PAGE, TRACKING_MODES.HYBRID];

// Load persisted settings, per-mode counts/stats, and storage usage into state.
export async function initializeData() {
  const settings = (await storage.getSettings()) ?? DEFAULT_SETTINGS;
  dispatch('SETTINGS_LOADED', { settings });

  await refreshCounts();
  await refreshUsage();
}

export async function refreshCounts() {
  const counts = {};
  for (const mode of ALL_MODES) {
    counts[mode] = await storage.countElementsByMode(mode);
  }
  dispatch('COUNTS_LOADED', { counts });

  const stats = await storage.getAllStats();
  dispatch('STATS_LOADED', { stats });
}

export async function refreshUsage() {
  const usage = await storage.estimateUsage();
  dispatch('USAGE_LOADED', { usage });
}

export async function persistSettings() {
  await storage.saveSettings(getState().settings);
}

// Persist a batch of captured/scanned elements + update the mode's stat counters.
export async function persistCapture(mode, sessionId, elements, captureTypeCounts) {
  if (Array.isArray(elements) && elements.length > 0) {
    await storage.addElements(mode, sessionId, elements);
  }
  if (captureTypeCounts) {
    const existing = (await storage.getStats(mode)).counts ?? {};
    const merged = { ...existing };
    for (const [k, v] of Object.entries(captureTypeCounts)) {
      merged[k] = (merged[k] ?? 0) + v;
    }
    await storage.setStats(mode, merged);
  }
  await refreshCounts();
  await refreshUsage();
}

export async function clearMode(mode) {
  await storage.clearElementsByMode(mode);
  await storage.clearStats(mode);
  await refreshCounts();
  await refreshUsage();
}

export async function clearAllModes() {
  await storage.clearAllElements();
  for (const mode of ALL_MODES) {
    await storage.clearStats(mode);
  }
  await refreshCounts();
  await refreshUsage();
}

export async function getElementsForMode(mode) {
  return storage.getElementsByMode(mode);
}
