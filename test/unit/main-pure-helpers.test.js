'use strict';

// Pure-helper unit coverage for src/main/* modules.
//
// Reachability audit (done against the real source, not the brief):
//   - resource-paths.js  → exports { mainDistributionDir }                ✓ testable
//   - browser-detector.js → exports { detectBrowsers, _resetCache } only.
//       _parseRegStringValue and _isCanonicalForChannel are module-private
//       (no export) → NOT reachable without hacking. Skipped below with notes.
//   - playwright-manager.js → exports { runScan, getBrowser, shutdownPlaywright,
//       getTrackerBundleSource }. _normalizeDescriptor is module-private
//       (no export) → NOT reachable. Skipped below with a note.
//
// mainDistributionDir() depends only on the module's own __dirname (no Electron,
// no Playwright), so the live module is imported directly for the no-asar branch.
// The app.asar→app.asar.unpacked branch can't be reached via the live module
// (the real __dirname never contains 'app.asar' under Vitest), so we exercise the
// ACTUAL source of that function in a vm sandbox with an injected __dirname —
// testing the real regex, not a reimplementation.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

import { mainDistributionDir } from '../../src/main/resource-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirnameTest = path.dirname(__filename);
const RESOURCE_PATHS_SRC = path.resolve(
  __dirnameTest,
  '../../src/main/resource-paths.js'
);

// Load the real resource-paths.js source into a CommonJS-style sandbox with an
// arbitrary __dirname so we can drive both branches of mainDistributionDir
// using the source's own implementation.
function loadMainDistributionDirWithDirname(injectedDirname) {
  const source = readFileSync(RESOURCE_PATHS_SRC, 'utf8');
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    __dirname: injectedDirname,
    __filename: path.join(injectedDirname, 'resource-paths.js'),
    require,
  };
  vm.runInNewContext(source, sandbox, { filename: 'resource-paths.js' });
  return moduleObj.exports.mainDistributionDir;
}

describe('resource-paths :: mainDistributionDir', () => {
  it('is exported as a function (CJS named export)', () => {
    expect(typeof mainDistributionDir).toBe('function');
  });

  it('returns the real __dirname unchanged when it contains no app.asar', () => {
    // The test process never runs from inside an asar archive.
    const result = mainDistributionDir();
    expect(typeof result).toBe('string');
    expect(result).not.toContain('app.asar');
    // Should be the directory holding resource-paths.js itself.
    expect(result.replace(/\\/g, '/').endsWith('src/main')).toBe(true);
  });

  describe('app.asar → app.asar.unpacked rewriting (via real source, injected __dirname)', () => {
    let fn;
    beforeAll(() => {
      fn = loadMainDistributionDirWithDirname('/tmp/normal/main');
    });

    it('vm-loaded source exposes mainDistributionDir', () => {
      expect(typeof fn).toBe('function');
    });

    it('passes through a posix __dirname with no asar segment', () => {
      const f = loadMainDistributionDirWithDirname('/opt/app/main');
      expect(f()).toBe('/opt/app/main');
    });

    it('rewrites a posix asar path: /app.asar/main → /app.asar.unpacked/main', () => {
      const f = loadMainDistributionDirWithDirname('/Applications/Foo/app.asar/main');
      expect(f()).toBe('/Applications/Foo/app.asar.unpacked/main');
    });

    it('rewrites a Windows backslash asar path', () => {
      const f = loadMainDistributionDirWithDirname('C:\\Foo\\app.asar\\main');
      expect(f()).toBe('C:\\Foo\\app.asar.unpacked\\main');
    });

    it('only rewrites the asar separator boundary, leaving the basename intact', () => {
      // 'app.asar' followed by a separator is the trigger. The trailing
      // path after the separator must be preserved verbatim.
      const f = loadMainDistributionDirWithDirname('/x/app.asar/dist/sub');
      expect(f()).toBe('/x/app.asar.unpacked/dist/sub');
    });

    it('rewrites every asar/sep occurrence (global flag), not just the first', () => {
      // Pathological but proves the /g flag: two boundaries both get rewritten.
      const f = loadMainDistributionDirWithDirname('/a/app.asar/b/app.asar/c');
      expect(f()).toBe('/a/app.asar.unpacked/b/app.asar.unpacked/c');
    });

    it('does NOT rewrite "app.asar" when it is the trailing segment with no following separator', () => {
      // The regex requires a separator AFTER app.asar, so a bare trailing
      // 'app.asar' (no child path) is left untouched. Documents real behavior.
      const f = loadMainDistributionDirWithDirname('/x/app.asar');
      expect(f()).toBe('/x/app.asar');
    });

    it('preserves mixed-separator input on the non-matching side', () => {
      // Backslash boundary triggers; forward slashes elsewhere are untouched.
      const f = loadMainDistributionDirWithDirname('C:\\Foo\\app.asar\\a/b/c');
      expect(f()).toBe('C:\\Foo\\app.asar.unpacked\\a/b/c');
    });
  });
});

// ---------------------------------------------------------------------------
// Unexported helpers requested by the brief but NOT reachable.
// Per the task rules: SKIP cleanly rather than hacking module internals.
// These are documented so the gap is visible to the runner and to humans.
// ---------------------------------------------------------------------------

describe('playwright-manager :: _normalizeDescriptor', () => {
  // NOT in module.exports — exports are { runScan, getBrowser,
  // shutdownPlaywright, getTrackerBundleSource }. The function is only used
  // internally by getBrowser and is unreachable as a pure unit without
  // launching a real browser. Skipping per the "test only what IS exported"
  // rule. (Importing the module also requires real Playwright + electron-log.)
  it.skip('SKIPPED: _normalizeDescriptor is not exported from playwright-manager.js', () => {});
});

describe('browser-detector :: _parseRegStringValue', () => {
  // NOT in module.exports — exports are { detectBrowsers, _resetCache }.
  // Pure regex parser, but module-private; reaching it would require editing
  // the source or executing it in a vm with full electron-log/child_process
  // stubs, which the rules say to avoid. Skipped.
  it.skip('SKIPPED: _parseRegStringValue is not exported from browser-detector.js', () => {});
});

describe('browser-detector :: _isCanonicalForChannel', () => {
  // NOT in module.exports (same as above). Skipped per the unexported-helper rule.
  it.skip('SKIPPED: _isCanonicalForChannel is not exported from browser-detector.js', () => {});
});
