'use strict';

const path = require('path');
const { defineConfig } = require('vitest/config');

// Mirrors the webpack alias map so tests import core/security exactly as the app
// does (require('@security/guards.js'), require('@core/automation/...')).
module.exports = defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@security': path.resolve(__dirname, 'src/security'),
    },
  },
  test: {
    // Default to node; DOM-dependent specs opt in per-file with the docblock:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['test/**/*.test.{js,mjs}'],
    exclude: ['node_modules/**', 'dist/**', 'release/**'],
    // Integration specs launch a real Playwright browser — give them room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['test/setup/global-setup.js'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.js'],
      exclude: [
        'src/**/_page_stubs_/**',
        'src/renderer/theme-bootstrap.js',
        'src/**/*.config.js',
      ],
    },
  },
});
