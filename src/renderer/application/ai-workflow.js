'use strict';

import storage from '../infrastructure/idb-repository.js';
import { getState } from '../state.js';
import { Toast } from '../components/toast.js';
import { sanitize } from '../utils/sanitize.js';

const api = window.elementTrackerAPI;

let _running = false;
let _operationId = null;
let _lastSpec = null;
let _progressDisposer = null;
let _transcript = []; // plain-text lines of the run, persisted with the AI test
let _onSaved = null; // callback fired after an AI test is persisted (to refresh the list)

export function setOnAiTestSaved(cb) {
  _onSaved = cb;
}

function el(id) {
  return document.getElementById(id);
}

function makeOperationId() {
  return `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function browserType() {
  return getState().selectedBrowser?.browserType ?? 'chromium';
}

function logLine(html, cls, plain) {
  // Capture a plain-text version for the persisted transcript (strip tags).
  const text = plain != null ? plain : html.replace(/<[^>]+>/g, '').trim();
  if (text) {
    _transcript.push(text);
  }
  const logEl = el('ai-stream-log');
  if (!logEl) {
    return;
  }
  const row = document.createElement('div');
  row.className = `ai-stream__row${cls ? ' ' + cls : ''}`;
  row.innerHTML = html;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderProgress(ev) {
  if (!ev) {
    return;
  }
  switch (ev.kind) {
    case 'init':
      logLine(`<span class="ai-tag">init</span> model ${sanitize(ev.model ?? '')}`, 'ai-stream__row--meta');
      break;
    case 'retry':
      logLine(`<span class="ai-tag ai-tag--warn">retry</span> attempt ${ev.attempt} (${sanitize(ev.error ?? '')})`, 'ai-stream__row--meta');
      break;
    case 'assistant':
      for (const item of ev.items) {
        if (item.kind === 'text') {
          logLine(sanitize(item.text));
        } else if (item.kind === 'tool_use') {
          const inp = item.input ? sanitize(JSON.stringify(item.input).slice(0, 120)) : '';
          logLine(`<span class="ai-tag ai-tag--tool">${sanitize(item.tool)}</span> ${inp}`, 'ai-stream__row--tool');
        }
      }
      break;
    case 'tool_result':
      for (const r of ev.results) {
        const cls = r.isError ? 'ai-stream__row--err' : 'ai-stream__row--ok';
        const tag = r.isError ? 'ai-tag--err' : 'ai-tag--ok';
        logLine(`<span class="ai-tag ${tag}">${r.isError ? 'fail' : 'ok'}</span> ${sanitize((r.text || '').slice(0, 200))}`, cls);
      }
      break;
    case 'result':
      logLine(
        `<span class="ai-tag ${ev.success ? 'ai-tag--ok' : 'ai-tag--err'}">${ev.success ? 'done' : 'ended'}</span> ` +
          `${ev.durationMs ? Math.round(ev.durationMs / 100) / 10 + 's' : ''}${ev.costUsd != null ? ' · $' + ev.costUsd.toFixed(4) : ''}`,
        'ai-stream__row--meta'
      );
      break;
    default:
      break;
  }
}

function setRunningUI(running) {
  _running = running;
  el('ai-run-btn').hidden = running;
  el('ai-cancel-btn').hidden = !running;
  el('ai-stream').hidden = false;
  const dot = el('ai-running-dot');
  if (dot) {
    dot.hidden = !running;
  }
}

// Populate the grounding-report dropdown from current reports in state.
export function refreshAiReportOptions(reports) {
  const sel = el('ai-report');
  if (!sel) {
    return;
  }
  const current = sel.value;
  sel.innerHTML = '<option value="">None (discover live)</option>';
  for (const r of reports ?? []) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.host || r.url || r.id} · ${r.mode} · ${r.totalElements ?? 0} el`;
    sel.appendChild(opt);
  }
  if (current) {
    sel.value = current;
  }
}

export async function checkClaudeCli() {
  try {
    const res = await api.aiCheckCli();
    const banner = el('ai-cli-banner');
    const text = el('ai-cli-banner-text');
    if (res?.ok) {
      if (banner) {
        banner.hidden = true;
      }
      return true;
    }
    if (banner && text) {
      banner.hidden = false;
      text.textContent =
        'Claude Code is required for AI Automation. Install it and run "claude login", then reopen this tab.';
    }
    return false;
  } catch {
    return false;
  }
}

export async function runAiGeneration() {
  // Claim the run synchronously: there are awaits below (CLI check, IndexedDB
  // read) before setRunningUI flips the flag, so a guard read at the top alone
  // would let a double-click spawn two concurrent agents.
  if (_running) {
    return;
  }
  _running = true;

  const startUrl = el('ai-url')?.value?.trim();
  const stepsText = el('ai-steps')?.value?.trim();
  const reportId = el('ai-report')?.value || null;
  const errEl = el('ai-error');
  if (errEl) {
    errEl.textContent = '';
  }

  // Validation failures must release the claimed flag before returning.
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    if (errEl) {
      errEl.textContent = 'Enter a valid http(s) start URL.';
    }
    _running = false;
    return;
  }
  if (!stepsText) {
    if (errEl) {
      errEl.textContent = 'Describe the steps in plain English.';
    }
    _running = false;
    return;
  }

  const ok = await checkClaudeCli();
  if (!ok) {
    _running = false;
    return;
  }

  // Load grounding report elements (if chosen) from IndexedDB.
  let reportElements = null;
  let reportMeta = null;
  if (reportId) {
    try {
      reportElements = await storage.getReportElements(reportId);
      reportMeta = (getState().reports ?? []).find((r) => r.id === reportId) ?? { id: reportId };
    } catch {
      reportElements = null;
    }
  }

  _operationId = makeOperationId();
  _lastSpec = null;
  _transcript = [];
  el('ai-stream-log').innerHTML = '';
  el('ai-result').hidden = true;
  setRunningUI(true);
  logLine('<span class="ai-tag">start</span> launching agent…', 'ai-stream__row--meta');

  _progressDisposer = api.onAiProgress?.((payload) => {
    if (payload?.operationId === _operationId) {
      renderProgress(payload.event);
    }
  });

  try {
    const res = await api.aiRun({
      operationId: _operationId,
      startUrl,
      stepsText,
      browserType: browserType(),
      reportElements,
      reportMeta,
    });

    if (!res?.success) {
      const msg = res?.error || res?.result?.stderr || 'Generation did not complete.';
      if (errEl) {
        errEl.textContent = msg;
      }
      Toast.error('AI generation failed', msg.slice(0, 120));
    } else {
      const result = res.result || {};
      _lastSpec = result.spec || null;
      renderResult(result, { startUrl, stepsText, reportMeta });
      Toast.success('Test generated');
    }
  } catch (err) {
    if (errEl) {
      errEl.textContent = err?.message ?? String(err);
    }
  } finally {
    setRunningUI(false);
    _progressDisposer?.();
    _progressDisposer = null;
  }
}

function renderResult(result, { startUrl, stepsText, reportMeta }) {
  const verdict = el('ai-verdict');
  const specEl = el('ai-spec')?.querySelector('code');
  el('ai-result').hidden = false;
  if (verdict) {
    const bits = [];
    bits.push(result.success ? '✓ completed' : '✗ ended');
    if (result.durationMs) {
      bits.push(`${Math.round(result.durationMs / 100) / 10}s`);
    }
    if (result.costUsd != null) {
      bits.push(`$${result.costUsd.toFixed(4)}`);
    }
    verdict.textContent = bits.join(' · ');
  }
  if (specEl) {
    specEl.textContent = result.spec || '(no spec was written)';
  }

  // Persist the full AI Test record — including the user's English steps and the
  // run transcript — then refresh the left-pane list.
  void storage
    .saveAiTest({
      startUrl,
      stepsText: stepsText ?? '',
      browserType: browserType(),
      reportId: reportMeta?.id ?? null,
      reportLabel: reportMeta ? reportMeta.host || reportMeta.url || reportMeta.id : null,
      spec: result.spec ?? null,
      resultText: result.resultText ?? null,
      transcript: _transcript.slice(),
      success: !!result.success,
      durationMs: result.durationMs ?? null,
      costUsd: result.costUsd ?? null,
    })
    .then(() => {
      _onSaved?.();
    })
    .catch(() => {});
}

export async function cancelAiGeneration() {
  if (!_running || !_operationId) {
    return;
  }
  await api.aiCancel?.({ operationId: _operationId });
  logLine('<span class="ai-tag ai-tag--warn">cancel</span> requested…', 'ai-stream__row--meta');
}

export async function exportAiSpec() {
  if (!_lastSpec) {
    Toast.warning('Nothing to export', 'Generate a test first.');
    return;
  }
  const res = await api.exportFile({ content: _lastSpec, filename: 'generated.spec.ts', format: 'js' });
  if (res?.success) {
    Toast.success('Spec exported');
  } else if (res?.reason !== 'cancelled') {
    Toast.error('Export failed', res?.error ?? undefined);
  }
}
