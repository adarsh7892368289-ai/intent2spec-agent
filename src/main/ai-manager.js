'use strict';

// Drives Claude Code headlessly to generate a Playwright test from English steps.
// Auth = the user's existing Claude Code login (no API key). The app exposes its
// capabilities via the bundled MCP stdio server (dist/mcp/server.js); the
// orchestration prompt (planner/generator/healer) is injected via
// --append-system-prompt-file. Stream-json events are parsed and forwarded to the
// renderer as structured progress.

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('electron-log');

const { mainDistributionDir } = require('./resource-paths');

const MCP_SERVER_NAME = 'ata';
const ALLOWED_TOOLS = `mcp__${MCP_SERVER_NAME}__*`;

// Resolve the dist root that actually contains mcp/server.js. In a packaged
// build the bundled main lives in dist/ (so mainDistributionDir() is dist/);
// in dev, webpack emits main to dist/ while the SOURCE of this file is src/main/,
// so probe the likely locations and pick the one where mcp/server.js exists.
let _distDirCache = null;
function _distDir() {
  if (_distDirCache) {
    return _distDirCache;
  }
  const candidates = [
    mainDistributionDir(), // packaged: dist/
    path.join(process.cwd(), 'dist'), // dev: webpack output
    path.join(__dirname, '..', '..', 'dist'), // src/main -> ../../dist
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'mcp', 'server.js'))) {
        _distDirCache = c;
        return c;
      }
    } catch {
      void 0;
    }
  }
  _distDirCache = mainDistributionDir();
  return _distDirCache;
}

// Resolve the `claude` CLI executable. Returns { ok, path } or { ok:false }.
function detectClaudeCli() {
  const candidates = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      if (r.status === 0 && /\d+\.\d+/.test(r.stdout || '')) {
        return { ok: true, bin, version: (r.stdout || '').trim() };
      }
    } catch {
      void 0;
    }
  }
  return { ok: false };
}

// Build the MCP config JSON Claude Code uses to launch our stdio server.
function _writeMcpConfig({ browserType, headless, handoffPath, outputDir, tmpDir }) {
  const serverPath = path.join(_distDir(), 'mcp', 'server.js');
  const cfg = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath, // bundled node/electron node runtime
        args: [serverPath],
        env: {
          ATA_BROWSER: browserType || 'chromium',
          ATA_HEADLESS: headless === false ? 'false' : 'true',
          ATA_OUTPUT_DIR: outputDir,
          ...(handoffPath ? { ATA_HANDOFF: handoffPath } : {}),
          ELECTRON_RUN_AS_NODE: '1', // run server.js as plain node, not an electron GUI
        },
      },
    },
  };
  const cfgPath = path.join(tmpDir, 'mcp-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfgPath;
}

function _orchestrationPromptPath() {
  // Shipped next to the mcp server in dist; falls back to the source skill folder in dev.
  const candidates = [
    path.join(_distDir(), 'mcp', 'orchestration.md'),
    path.join(process.cwd(), '.claude', 'skills', 'agentic-test-automation', 'orchestration.md'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

function _buildTaskPrompt({ startUrl, stepsText, reportId }) {
  return [
    'Generate a Playwright test for the following flow, using only the ata MCP tools.',
    reportId ? `A grounding report is available (id ${reportId}); you may read_report it as a head-start, but always scan_page live pages.` : '',
    `Start URL: ${startUrl}`,
    '',
    'Steps (plain English):',
    stepsText,
    '',
    'Follow the planner → generator → healer workflow in your system instructions. Write the final spec with write_spec when done.',
  ]
    .filter(Boolean)
    .join('\n');
}

// Parse one stream-json line into a normalized progress event (or null to ignore).
function _normalizeEvent(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  switch (obj.type) {
    case 'system':
      if (obj.subtype === 'init') {
        return { kind: 'init', model: obj.model ?? null, mcp: obj.mcp_servers ?? obj.tools ?? null };
      }
      if (obj.subtype === 'api_retry') {
        return { kind: 'retry', attempt: obj.attempt, error: obj.error };
      }
      return null;
    case 'assistant': {
      // assistant message: surface text + tool_use blocks
      const blocks = obj.message?.content ?? [];
      const out = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text?.trim()) {
          out.push({ kind: 'text', text: b.text });
        } else if (b.type === 'tool_use') {
          out.push({ kind: 'tool_use', tool: b.name, input: b.input });
        }
      }
      return out.length ? { kind: 'assistant', items: out } : null;
    }
    case 'user': {
      // tool results come back as user messages
      const blocks = obj.message?.content ?? [];
      const results = blocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({
          isError: !!b.is_error,
          text: Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : String(b.content ?? ''),
        }));
      return results.length ? { kind: 'tool_result', results } : null;
    }
    case 'result':
      return {
        kind: 'result',
        success: obj.subtype === 'success' && !obj.is_error,
        result: obj.result ?? null,
        costUsd: obj.total_cost_usd ?? null,
        durationMs: obj.duration_ms ?? null,
      };
    default:
      return null;
  }
}

// Hard wall-clock ceiling for one generation. An agentic multi-page run can
// legitimately take minutes (a real run measured ~214s), so this is generous;
// its job is to guarantee the promise always settles even if `claude` wedges.
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
// Grace period between SIGTERM and SIGKILL. `claude` spawns descendants (the MCP
// server + its headless browser) that may not exit on a polite SIGTERM.
const KILL_GRACE_MS = 5000;

// Per-run dollar ceiling, passed to the CLI as --max-budget-usd. This is a
// runaway BACKSTOP, not a leash — sized with large headroom so no legitimate run
// is ever cut off mid-flow:
//   • A verified real run cost < $0.10.
//   • A heavy enterprise multi-page flow (many pages, scans, heals, retries,
//     and any browser — browser choice doesn't change token cost, only timing)
//     stays well under $1.
//   • $5 is ~50-100x a normal run, yet still halts a true runaway loop (which,
//     left only to the 10-min wall clock, could otherwise burn ~$5-10).
// Override per-deployment with ATA_MAX_BUDGET_USD (set to '0'/'off' to disable).
const DEFAULT_MAX_BUDGET_USD = 5.0;

function _resolveMaxBudgetUsd(explicit) {
  const raw = explicit != null ? explicit : process.env.ATA_MAX_BUDGET_USD;
  if (raw == null || raw === '') {
    return DEFAULT_MAX_BUDGET_USD;
  }
  if (raw === 'off' || raw === 'false') {
    return null; // explicitly disabled
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BUDGET_USD;
}

// Best-effort recursive removal of the per-run temp dir. Holds the MCP config,
// the grounding handoff (which contains captured element data — don't leave it
// on disk), and the generated spec, all of which we've already consumed.
function _cleanupTmp(dir) {
  if (!dir) {
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    void 0;
  }
}

// Run a generation. onEvent(normalizedEvent) is called for each progress event.
// Returns { success, resultText, costUsd, durationMs, specPath }.
function runGeneration({ startUrl, stepsText, browserType, reportElements, reportMeta, onEvent, signal, timeoutMs, maxBudgetUsd }) {
  return new Promise((resolve, reject) => {
    const cli = detectClaudeCli();
    if (!cli.ok) {
      reject(Object.assign(new Error('Claude Code CLI not found. Install it and run `claude login`.'), { code: 'CLAUDE_CLI_MISSING' }));
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ata-run-'));
    const outputDir = tmpDir;

    let handoffPath = null;
    let reportId = null;
    if (Array.isArray(reportElements) && reportElements.length) {
      reportId = reportMeta?.id || 'grounding';
      handoffPath = path.join(tmpDir, 'handoff.json');
      fs.writeFileSync(
        handoffPath,
        JSON.stringify({ report: { id: reportId, url: reportMeta?.url ?? startUrl, mode: reportMeta?.mode ?? 'scan', elements: reportElements } }),
        'utf8'
      );
    }

    const mcpConfigPath = _writeMcpConfig({ browserType, headless: true, handoffPath, outputDir, tmpDir });
    const orchestrationPath = _orchestrationPromptPath();
    if (!orchestrationPath) {
      _cleanupTmp(tmpDir);
      reject(new Error('orchestration.md not found — run the build.'));
      return;
    }

    const taskPrompt = _buildTaskPrompt({ startUrl, stepsText, reportId });

    const args = [
      '-p',
      taskPrompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt-file',
      orchestrationPath,
      '--mcp-config',
      mcpConfigPath,
      '--strict-mcp-config',
      '--allowedTools',
      ALLOWED_TOOLS,
      '--permission-mode',
      'dontAsk',
    ];

    // Hard per-run cost backstop (works with -p). Generously sized so it never
    // trips a legitimate run; halts a runaway before the wall-clock would.
    const budgetUsd = _resolveMaxBudgetUsd(maxBudgetUsd);
    if (budgetUsd != null) {
      args.push('--max-budget-usd', String(budgetUsd));
    }

    log.info('[AI] spawning claude', { bin: cli.bin, version: cli.version, startUrl, hasReport: !!handoffPath, budgetUsd });

    // Spawn in a clean env WITHOUT ELECTRON_RUN_AS_NODE so the user's Claude Code
    // login (OAuth/keychain) is used, not node mode.
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // Portability + backend-safety: disable extended thinking for the run.
    // On the Anthropic API this turns thinking off; on third-party providers
    // (Bedrock / corporate LLM gateways) it OMITS the `thinking` parameter,
    // which some gateways reject ("thinking.type.enabled not supported"). We
    // also clear any inherited effort override so the run uses a clean baseline.
    childEnv.MAX_THINKING_TOKENS = '0';
    delete childEnv.CLAUDE_EFFORT;
    delete childEnv.CLAUDE_CODE_EFFORT_LEVEL;

    const child = spawn(cli.bin, args, {
      cwd: tmpDir,
      env: childEnv,
      windowsHide: true,
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let lastResult = null;
    let timedOut = false;

    // Escalating kill: polite SIGTERM, then SIGKILL after a grace period for any
    // descendant (MCP server + browser) that ignored the first signal.
    let killTimer = null;
    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        void 0;
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            void 0;
          }
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const wallClock = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_RUN_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      killChild();
    }, wallClock);
    timeoutHandle.unref?.();

    const onAbort = () => killChild();
    if (signal) {
      if (signal.aborted) {
        killChild();
      } else {
        signal.addEventListener('abort', onAbort);
      }
    }

    const finalizeCleanup = () => {
      clearTimeout(timeoutHandle);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) {
          continue;
        }
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // non-JSON noise
        }
        const ev = _normalizeEvent(obj);
        if (ev) {
          if (ev.kind === 'result') {
            lastResult = ev;
          }
          try {
            onEvent?.(ev);
          } catch (err) {
            log.warn('[AI] onEvent threw', { error: err?.message });
          }
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      finalizeCleanup();
      _cleanupTmp(tmpDir);
      reject(err);
    });

    child.on('close', (codeNum) => {
      if (settled) {
        return;
      }
      settled = true;
      finalizeCleanup();
      // Find the most recent written spec in outputDir, and read it BEFORE we
      // remove the temp dir.
      let specPath = null;
      let spec = null;
      try {
        const specs = fs
          .readdirSync(outputDir)
          .filter((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.js'))
          .map((f) => path.join(outputDir, f));
        if (specs.length) {
          specPath = specs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
          spec = fs.readFileSync(specPath, 'utf8');
        }
      } catch {
        void 0;
      }
      _cleanupTmp(tmpDir);
      // Detect a budget-stop so the UI can show a precise reason rather than a
      // generic failure. The CLI ends the run when spend reaches the cap; the
      // reported cost lands at/above it, and/or stderr mentions the budget.
      const budgetHit =
        !timedOut &&
        !lastResult?.success &&
        ((budgetUsd != null && lastResult?.costUsd != null && lastResult.costUsd >= budgetUsd * 0.98) ||
          /budget/i.test(stderrBuf));
      let stderrOut = stderrBuf.slice(0, 4000);
      if (timedOut) {
        stderrOut = `Generation timed out after ${Math.round(wallClock / 1000)}s.\n${stderrOut}`;
      } else if (budgetHit) {
        stderrOut = `Generation stopped at the $${budgetUsd} per-run budget cap (spent ~$${(lastResult?.costUsd ?? 0).toFixed(4)}). Raise ATA_MAX_BUDGET_USD if your flow legitimately needs more.\n${stderrOut}`;
      }
      resolve({
        success: !timedOut && !budgetHit && !!lastResult?.success && codeNum === 0,
        exitCode: codeNum,
        timedOut,
        budgetHit,
        budgetUsd,
        resultText: lastResult?.result ?? null,
        costUsd: lastResult?.costUsd ?? null,
        durationMs: lastResult?.durationMs ?? null,
        specPath,
        spec,
        stderr: stderrOut,
      });
    });
  });
}

module.exports = { detectClaudeCli, runGeneration };
