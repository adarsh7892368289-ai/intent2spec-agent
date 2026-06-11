'use strict';

// MCP stdio server: exposes the app's capabilities to an AI agent (Claude Code).
// The agent navigates, scans the live page into a ranked locator inventory, and
// acts/asserts by referencing inventory entries — never raw selectors. This is
// the grounding boundary: the model picks from validated locators only.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');

const { PageSession } = require('./page-session.js');
const { projectLocators, recommendedLocator } = require('@core/automation/locator-projection.js');
const { assertHttpUrl } = require('@security/guards.js');

// ---- session state ----------------------------------------------------------

const BROWSER_TYPE = process.env.ATA_BROWSER || 'chromium';
const HEADLESS = process.env.ATA_HEADLESS !== 'false';
const HANDOFF_PATH = process.env.ATA_HANDOFF || null; // optional grounding report JSON

const session = new PageSession({ browserType: BROWSER_TYPE, headless: HEADLESS });

// Current page inventory + its projected locators, kept in lockstep.
let currentInventory = []; // enriched elements
let currentLocators = []; // [{ index, name, role, recommended, all:[...] }]

function reprojectInventory(elements) {
  currentInventory = elements || [];
  currentLocators = currentInventory.map((el, index) => ({
    index,
    name: el.name || el.label || '',
    role: el.tagName || el.metadata?.tag || '',
    captureType: el.captureType || 'scan',
    recommended: recommendedLocator(el),
    locators: projectLocators(el),
  }));
  return currentLocators;
}

// A compact, model-facing view of the inventory (don't dump full enriched objects).
function inventoryView() {
  return currentLocators
    .filter((l) => l.recommended)
    .map((l) => ({
      ref: l.index,
      name: l.name,
      role: l.role,
      type: l.captureType,
      locator: l.recommended.code,
      kind: l.recommended.kind,
    }));
}

// Turn a projected locator entry into a live Playwright Locator on the page.
async function resolveLocator(page, projected) {
  const loc = projected;
  switch (loc.kind) {
    case 'testId':
      return page.getByTestId(loc.value);
    case 'role':
      return loc.name ? page.getByRole(loc.role, { name: loc.name }) : page.getByRole(loc.role);
    case 'label':
      return page.getByLabel(loc.value);
    case 'placeholder':
      return page.getByPlaceholder(loc.value);
    case 'text':
      return page.getByText(loc.value, { exact: true });
    case 'css':
      return page.locator(loc.value);
    case 'xpath':
      return page.locator(`xpath=${loc.value}`);
    default:
      return page.locator(loc.value);
  }
}

// Resolve a locatorRef (index) to the best live Playwright Locator, trying ranked
// fallbacks (tier-1 self-heal) until one resolves to exactly one visible element.
async function bindRef(page, ref) {
  const entry = currentLocators[ref];
  if (!entry) {
    return { ok: false, reason: `No inventory entry at ref ${ref}` };
  }
  let lastErr = null;
  // `healed` means we had to fall PAST the top-ranked locator (index 0) to a
  // fallback — i.e. the preferred locator didn't resolve. Compare by position,
  // not object identity (entry.recommended is a separate projection instance).
  for (let i = 0; i < entry.locators.length; i++) {
    const projected = entry.locators[i];
    try {
      const locator = await resolveLocator(page, projected);
      const count = await locator.count();
      if (count >= 1) {
        return { ok: true, locator, used: projected, healed: i > 0 };
      }
    } catch (err) {
      lastErr = err?.message;
    }
  }
  return { ok: false, reason: lastErr || `No ranked locator for ref ${ref} resolved` };
}

// ---- server + tools ---------------------------------------------------------

const server = new McpServer({ name: 'agentic-test-automation', version: '1.0.0' });

server.registerTool(
  'list_reports',
  {
    description:
      'List captured locator-inventory reports handed off by the app (grounding sources). ' +
      'Returns report metadata; use read_report to load one as the starting inventory.',
    inputSchema: {},
  },
  async () => {
    if (!HANDOFF_PATH || !fs.existsSync(HANDOFF_PATH)) {
      return { content: [{ type: 'text', text: JSON.stringify({ reports: [] }) }] };
    }
    try {
      const data = JSON.parse(fs.readFileSync(HANDOFF_PATH, 'utf8'));
      const reports = Array.isArray(data.reports) ? data.reports : data.report ? [data.report] : [];
      const meta = reports.map((r) => ({ id: r.id, url: r.url, mode: r.mode, totalElements: (r.elements || []).length }));
      return { content: [{ type: 'text', text: JSON.stringify({ reports: meta }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ reports: [], error: err.message }) }] };
    }
  }
);

server.registerTool(
  'read_report',
  {
    description:
      'Load a handed-off report as the current grounding inventory (without visiting a page). ' +
      'Useful as a head-start; live scan_page calls refine/replace it per page.',
    inputSchema: { reportId: z.string().describe('Report id from list_reports') },
  },
  async ({ reportId }) => {
    if (!HANDOFF_PATH || !fs.existsSync(HANDOFF_PATH)) {
      return { content: [{ type: 'text', text: 'No handoff report available.' }], isError: true };
    }
    const data = JSON.parse(fs.readFileSync(HANDOFF_PATH, 'utf8'));
    const reports = Array.isArray(data.reports) ? data.reports : data.report ? [data.report] : [];
    const report = reports.find((r) => r.id === reportId) || reports[0];
    if (!report) {
      return { content: [{ type: 'text', text: `Report ${reportId} not found.` }], isError: true };
    }
    reprojectInventory(report.elements || []);
    return { content: [{ type: 'text', text: JSON.stringify({ loaded: report.id, inventory: inventoryView() }) }] };
  }
);

server.registerTool(
  'navigate',
  {
    description: 'Navigate the live browser to an http(s) URL. Returns the resolved URL and title.',
    inputSchema: { url: z.string().describe('Absolute http(s) URL') },
  },
  async ({ url }) => {
    try {
      assertHttpUrl(url, 'navigate URL');
    } catch (err) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    try {
      const res = await session.navigate(url);
      return { content: [{ type: 'text', text: JSON.stringify(res) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `navigate failed: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'scan_page',
  {
    description:
      'Scan the CURRENT live page into a ranked, DOM-validated locator inventory. ' +
      'Call this whenever you arrive on a new page or the DOM changed. Returns a compact ' +
      'inventory: each entry has a numeric ref, accessible name, role, and the recommended ' +
      'Playwright locator. You MUST reference these refs in act/assert — never invent selectors.',
    inputSchema: {
      filters: z.array(z.string()).optional().describe('Optional CSS selectors/classes to narrow the scan'),
    },
  },
  async ({ filters }) => {
    try {
      const elements = await session.scan({ filters: filters ?? null, force: true });
      reprojectInventory(elements);
      const page = await session.page_();
      return {
        content: [
          { type: 'text', text: JSON.stringify({ url: page.url(), count: currentLocators.length, inventory: inventoryView() }) },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `scan_page failed: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'act',
  {
    description:
      'Perform an action on an element from the current inventory. locatorRef is the numeric ' +
      'ref from scan_page. Playwright auto-waits. On a stale recommended locator the server ' +
      'auto-tries the next ranked locator (tier-1 self-heal).',
    inputSchema: {
      locatorRef: z.number().int().describe('ref from scan_page inventory'),
      action: z.enum(['click', 'fill', 'check', 'uncheck', 'selectOption', 'submit']),
      value: z.string().optional().describe('text for fill, option for selectOption'),
    },
  },
  async ({ locatorRef, action, value }) => {
    let bound;
    try {
      const page = await session.page_();
      bound = await bindRef(page, locatorRef);
    } catch (err) {
      return { content: [{ type: 'text', text: `act failed: ${err.message}` }], isError: true };
    }
    if (!bound.ok) {
      return { content: [{ type: 'text', text: `act failed: ${bound.reason}` }], isError: true };
    }
    const { locator, used, healed } = bound;
    try {
      const target = locator.first();
      switch (action) {
        case 'click':
        case 'submit':
          await target.click();
          break;
        case 'fill':
          await target.fill(value ?? '');
          break;
        case 'check':
          await target.check();
          break;
        case 'uncheck':
          await target.uncheck();
          break;
        case 'selectOption':
          await target.selectOption(value ?? '');
          break;
      }
      return {
        content: [
          { type: 'text', text: JSON.stringify({ ok: true, action, locator: used.code, healed }) },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `act ${action} failed: ${err.message}` }], isError: true };
    }
  }
);

server.registerTool(
  'assert',
  {
    description:
      'Assert a condition on an inventory element (Playwright expect). Returns pass/fail.',
    inputSchema: {
      locatorRef: z.number().int(),
      kind: z.enum(['visible', 'hidden', 'hasText', 'hasValue', 'checked']),
      expected: z.string().optional().describe('expected text/value for hasText/hasValue'),
    },
  },
  async ({ locatorRef, kind, expected }) => {
    let bound;
    try {
      const page = await session.page_();
      bound = await bindRef(page, locatorRef);
    } catch (err) {
      return { content: [{ type: 'text', text: `assert failed: ${err.message}` }], isError: true };
    }
    if (!bound.ok) {
      return { content: [{ type: 'text', text: `assert failed: ${bound.reason}` }], isError: true };
    }
    const t = bound.locator.first();
    try {
      switch (kind) {
        case 'visible':
          await t.waitFor({ state: 'visible', timeout: 5000 });
          break;
        case 'hidden':
          await t.waitFor({ state: 'hidden', timeout: 5000 });
          break;
        case 'hasText': {
          const txt = (await t.textContent()) || '';
          if (!txt.includes(expected ?? '')) {
            throw new Error(`text "${txt.trim().slice(0, 60)}" does not contain "${expected}"`);
          }
          break;
        }
        case 'hasValue': {
          const val = await t.inputValue();
          if (val !== (expected ?? '')) {
            throw new Error(`value "${val}" !== "${expected}"`);
          }
          break;
        }
        case 'checked': {
          const checked = await t.isChecked();
          if (!checked) {
            throw new Error('element is not checked');
          }
          break;
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, kind, expected }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, kind, reason: err.message }) }], isError: true };
    }
  }
);

server.registerTool(
  'write_spec',
  {
    description:
      'Write the final Playwright test spec to disk. Provide the complete spec text. ' +
      'Returns the absolute path written.',
    inputSchema: {
      filename: z.string().describe('e.g. checkout.spec.ts'),
      content: z.string().describe('full Playwright test file content'),
    },
  },
  async ({ filename, content }) => {
    const outDir = process.env.ATA_OUTPUT_DIR || process.cwd();
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const target = `${outDir.replace(/[\\/]+$/, '')}/${safe}`;
    try {
      fs.writeFileSync(target, content, 'utf8');
      return { content: [{ type: 'text', text: JSON.stringify({ written: target }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `write_spec failed: ${err.message}` }], isError: true };
    }
  }
);

// ---- boot -------------------------------------------------------------------

async function main() {
  // Seed inventory from a single handed-off report if present (head-start).
  if (HANDOFF_PATH && fs.existsSync(HANDOFF_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(HANDOFF_PATH, 'utf8'));
      const report = (Array.isArray(data.reports) ? data.reports[0] : data.report) || null;
      if (report?.elements) {
        reprojectInventory(report.elements);
      }
    } catch {
      void 0;
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await session.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`[mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
