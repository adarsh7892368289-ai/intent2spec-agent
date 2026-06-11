'use strict';

import storage from '../infrastructure/idb-repository.js';
import { dispatch } from '../state.js';
import { refreshAiTests, refreshUsage } from './report-manager.js';

export function selectAiTest(id) {
  dispatch('AI_TEST_SELECTED', { id });
}

export function closeAiTest() {
  dispatch('AI_TEST_CLOSED');
}

export async function deleteAiTest(id) {
  await storage.deleteAiTest(id);
  dispatch('AI_TEST_DELETED', { id });
  await refreshUsage();
}

export async function clearAllAiTests() {
  const tests = await storage.getAiTests();
  for (const t of tests) {
    await storage.deleteAiTest(t.id);
  }
  dispatch('AI_TESTS_CLEARED');
  await refreshAiTests();
  await refreshUsage();
}
