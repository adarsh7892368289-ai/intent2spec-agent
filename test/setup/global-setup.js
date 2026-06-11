'use strict';

// Global Vitest setup. Runs before every test file (node and jsdom alike).
// Keep this minimal — per-suite needs (fake-indexeddb, DOM fixtures) live in the
// individual specs so node-environment specs don't pay for DOM polyfills.

import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});
