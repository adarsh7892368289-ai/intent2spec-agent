import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// ai-manager.js is a CJS main-process module that destructures `spawn` /
// `spawnSync` straight off `require('child_process')` at require time.
//
// In this Vitest setup, `vi.mock('child_process')` does NOT intercept a CJS
// `require()` of a node builtin (the builtin resolves natively, bypassing the
// mock registry — verified empirically). The robust, config-free technique is
// to monkeypatch the SHARED cached `child_process` export object before the
// module under test is (re)required: because `require()` returns the same
// cached object, and we re-import the module fresh per test via
// `vi.resetModules()`, the module captures our replacement on destructure.
// ---------------------------------------------------------------------------

const nodeRequire = createRequire(import.meta.url);
const cp = nodeRequire('child_process');
const realSpawnSync = cp.spawnSync;
const realSpawn = cp.spawn;

// Spies installed onto the shared cp object per test.
let spawnSync;
let spawn;

// Fresh module instance per test so the captured `spawnSync`/`spawn` reference
// and any internal caches (e.g. _distDir) are re-evaluated against our spies.
async function loadModule() {
  vi.resetModules();
  return import('../../src/main/ai-manager.js');
}

// A spawnSync return value the detector treats as a successful
// `claude --version`: status 0 + a version-looking stdout token (/\d+\.\d+/).
function okVersion(stdout = '1.2.3 (Claude Code)') {
  return { status: 0, stdout, stderr: '', signal: null, pid: 1, output: [] };
}

let originalPlatform;

beforeEach(() => {
  spawnSync = vi.fn();
  spawn = vi.fn();
  cp.spawnSync = spawnSync;
  cp.spawn = spawn;
  originalPlatform = process.platform;
});

afterEach(() => {
  cp.spawnSync = realSpawnSync;
  cp.spawn = realSpawn;
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p });
}

describe('ai-manager exported surface', () => {
  it('exports exactly detectClaudeCli and runGeneration as functions', async () => {
    const mod = await loadModule();
    expect(typeof mod.detectClaudeCli).toBe('function');
    expect(typeof mod.runGeneration).toBe('function');
  });

  it('does NOT export the internal pure helpers (_normalizeEvent / _buildTaskPrompt)', async () => {
    const mod = await loadModule();
    // Documents the actual surface: these are intentionally module-private,
    // so their behavior is not directly unit-testable from here.
    expect(mod._normalizeEvent).toBeUndefined();
    expect(mod._buildTaskPrompt).toBeUndefined();
  });
});

describe('detectClaudeCli', () => {
  it('returns { ok: true, bin, version } for a well-formed --version (status 0 + version string)', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue(okVersion('1.0.45 (Claude Code)'));
    const { detectClaudeCli } = await loadModule();

    const result = detectClaudeCli();
    expect(result.ok).toBe(true);
    expect(result.bin).toBe('claude');
    expect(result.version).toBe('1.0.45 (Claude Code)');
  });

  it('invokes spawnSync with the --version arg and a bounded timeout + windowsHide + utf8', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue(okVersion());
    const { detectClaudeCli } = await loadModule();

    detectClaudeCli();

    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnSync.mock.calls[0];
    expect(bin).toBe('claude');
    expect(args).toEqual(['--version']);
    expect(opts).toMatchObject({ encoding: 'utf8', windowsHide: true });
    expect(typeof opts.timeout).toBe('number');
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('on non-Windows tries only the bare "claude" candidate', async () => {
    setPlatform('darwin');
    spawnSync.mockReturnValue(okVersion());
    const { detectClaudeCli } = await loadModule();

    detectClaudeCli();

    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0][0]).toBe('claude');
  });

  it('on Windows tries claude.cmd, then claude.exe, then claude in order until one matches', async () => {
    setPlatform('win32');
    // First two candidates "miss" (non-zero status), third succeeds.
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not found' })
      .mockReturnValueOnce(okVersion('2.0.0'));
    const { detectClaudeCli } = await loadModule();

    const result = detectClaudeCli();

    expect(spawnSync.mock.calls.map((c) => c[0])).toEqual(['claude.cmd', 'claude.exe', 'claude']);
    expect(result).toEqual({ ok: true, bin: 'claude', version: '2.0.0' });
  });

  it('stops probing further candidates once a valid one is found (short-circuits)', async () => {
    setPlatform('win32');
    spawnSync.mockReturnValue(okVersion('3.1.4'));
    const { detectClaudeCli } = await loadModule();

    const result = detectClaudeCli();

    // The first candidate (claude.cmd) matches, so it must not probe further.
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(result.bin).toBe('claude.cmd');
  });

  it('trims surrounding whitespace from the reported version', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue(okVersion('  9.9.9 \n'));
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli().version).toBe('9.9.9');
  });

  it('matches the minimal X.Y version token (e.g. just "1.0")', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue(okVersion('1.0'));
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli()).toEqual({ ok: true, bin: 'claude', version: '1.0' });
  });

  it('returns { ok: false } when status is 0 but stdout has no version-like token', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue({ status: 0, stdout: 'claude code', stderr: '' });
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli()).toEqual({ ok: false });
  });

  it('returns { ok: false } when status is non-zero even if stdout looks like a version', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue({ status: 127, stdout: '1.2.3', stderr: 'command not found' });
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli()).toEqual({ ok: false });
  });

  it('returns { ok: false } when stdout is empty / whitespace-only', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue({ status: 0, stdout: '   ', stderr: '' });
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli()).toEqual({ ok: false });
  });

  it('treats a missing/undefined stdout as no version (no crash on `r.stdout || \'\'`)', async () => {
    setPlatform('linux');
    spawnSync.mockReturnValue({ status: 0, stdout: undefined, stderr: '' });
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli()).toEqual({ ok: false });
  });

  it('catches a thrown spawnSync (e.g. ENOENT) and returns { ok: false }', async () => {
    setPlatform('linux');
    spawnSync.mockImplementation(() => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    });
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli()).toEqual({ ok: false });
  });

  it('on Windows: if every candidate throws, returns { ok: false } after trying all three', async () => {
    setPlatform('win32');
    spawnSync.mockImplementation(() => {
      throw new Error('boom');
    });
    const { detectClaudeCli } = await loadModule();

    expect(detectClaudeCli()).toEqual({ ok: false });
    expect(spawnSync.mock.calls.map((c) => c[0])).toEqual(['claude.cmd', 'claude.exe', 'claude']);
  });

  it('continues to the next candidate after one throws (Windows .cmd throws, .exe succeeds)', async () => {
    setPlatform('win32');
    spawnSync
      .mockImplementationOnce(() => {
        throw new Error('cmd not on PATH');
      })
      .mockReturnValueOnce(okVersion('4.5.6'));
    const { detectClaudeCli } = await loadModule();

    const result = detectClaudeCli();
    expect(result).toEqual({ ok: true, bin: 'claude.exe', version: '4.5.6' });
  });
});

describe('runGeneration — CLI-missing guard (no real process is spawned)', () => {
  it('rejects with code CLAUDE_CLI_MISSING when no claude binary is detectable', async () => {
    setPlatform('linux');
    // spawnSync always "misses" => detectClaudeCli() returns { ok: false }.
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'not found' });
    const { runGeneration } = await loadModule();

    await expect(
      runGeneration({ startUrl: 'http://example.com', stepsText: 'click the button' })
    ).rejects.toMatchObject({ code: 'CLAUDE_CLI_MISSING' });

    // Must short-circuit BEFORE spawning the generation child process.
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects with a message that tells the user to install and run `claude login`', async () => {
    setPlatform('linux');
    spawnSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const { runGeneration } = await loadModule();

    await expect(
      runGeneration({ startUrl: 'http://example.com', stepsText: 'x' })
    ).rejects.toThrow(/Claude Code CLI not found[\s\S]*claude login/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Internal pure-logic coverage (_normalizeEvent / _buildTaskPrompt):
//
// The brief flags these as HIGH/MED value, but the module exports only
// detectClaudeCli + runGeneration. Per the assignment we do NOT modify the
// source export list purely for tests, and these helpers are unreachable from
// the exported surface without spawning a real `claude` process and feeding it
// crafted stream-json on stdout (an integration concern, not a unit one).
// They are intentionally deferred — see the structured `notes`.
// ---------------------------------------------------------------------------
describe.skip('_normalizeEvent (not exported — would require source change or integration spawn)', () => {
  // TODO(coverage): export _normalizeEvent for direct unit testing, or exercise
  // it through a runGeneration integration test that pipes stream-json to stdout.
  it('system/init -> { kind: "init", ... }', () => {});
});

describe.skip('_buildTaskPrompt (not exported — pure string builder)', () => {
  // TODO(coverage): export _buildTaskPrompt to assert prompt construction
  // (grounding-report line included only with reportId, startUrl interpolation,
  // stepsText preserved verbatim).
  it('includes the grounding-report line only when reportId is present', () => {});
});
