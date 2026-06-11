// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import repo from '../../src/renderer/infrastructure/idb-repository.js';

// fake-indexeddb/auto installs a real (in-memory) IndexedDB on the global, so
// these are full round-trips through the actual repository, not mocks. The repo
// caches its open-DB promise at module scope, so every test shares one DB; we
// scrub state in beforeEach to keep tests independent. We also use unique report
// ids per assertion where ordering/dedup matters.

// profiles/settings have no bulk-clear in the public API; clear their object
// stores directly through the (fake) global indexedDB so each test is isolated.
function clearStore(storeName) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('element_tracker_reports_db', 2);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        resolve();
        return;
      }
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    open.onerror = () => reject(open.error);
  });
}

async function resetStores() {
  await repo.clearAllReports();
  for (const t of await repo.getAiTests()) {
    await repo.deleteAiTest(t.id);
  }
  await clearStore('profiles');
  await clearStore('settings');
}

beforeEach(async () => {
  await resetStores();
});

// ---------------------------------------------------------------------------
// reports + elements split
// ---------------------------------------------------------------------------

describe('saveReport / getReports / getReportElements', () => {
  it('round-trips: save then get returns the report metadata and its elements', async () => {
    const report = { id: 'r1', mode: 'scan', url: 'http://x', host: 'x', timestamp: 100 };
    const elements = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }];

    const meta = await repo.saveReport(report, elements);

    // saveReport returns the persisted metadata with a derived totalElements.
    expect(meta.id).toBe('r1');
    expect(meta.totalElements).toBe(3);

    const reports = await repo.getReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe('r1');
    expect(reports[0].mode).toBe('scan');

    const els = await repo.getReportElements('r1');
    expect(els).toEqual(elements);
  });

  it('keeps the element array OUT of the report metadata (reports/elements split)', async () => {
    const report = { id: 'r-split', timestamp: 1, elements: [{ id: 'leak' }] };
    const meta = await repo.saveReport(report, [{ id: 'real1' }, { id: 'real2' }]);

    // The bundled `elements` key on the report object must be stripped from meta.
    expect(meta).not.toHaveProperty('elements');
    const reports = await repo.getReports();
    expect(reports[0]).not.toHaveProperty('elements');
    // totalElements reflects the separate elements arg, not the leaked field.
    expect(meta.totalElements).toBe(2);
    expect(await repo.getReportElements('r-split')).toEqual([{ id: 'real1' }, { id: 'real2' }]);
  });

  it('returns reports sorted by timestamp descending (newest first)', async () => {
    await repo.saveReport({ id: 'old', timestamp: 100 }, []);
    await repo.saveReport({ id: 'newest', timestamp: 300 }, []);
    await repo.saveReport({ id: 'mid', timestamp: 200 }, []);

    const reports = await repo.getReports();
    expect(reports.map((r) => r.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('treats reports with a missing timestamp as 0 when sorting', async () => {
    await repo.saveReport({ id: 'has-ts', timestamp: 50 }, []);
    await repo.saveReport({ id: 'no-ts' }, []);

    const reports = await repo.getReports();
    expect(reports[0].id).toBe('has-ts');
    expect(reports[1].id).toBe('no-ts');
  });

  it('defaults null/undefined elements to an empty array', async () => {
    await repo.saveReport({ id: 'null-els', timestamp: 1 }, null);
    await repo.saveReport({ id: 'undef-els', timestamp: 2 }, undefined);

    expect(await repo.getReportElements('null-els')).toEqual([]);
    expect(await repo.getReportElements('undef-els')).toEqual([]);
  });

  it('derives totalElements from report.totalElements when elements is not an array', async () => {
    const meta = await repo.saveReport({ id: 'count-fallback', timestamp: 1, totalElements: 42 }, null);
    expect(meta.totalElements).toBe(42);
  });

  it('derives totalElements to 0 when neither elements nor report.totalElements present', async () => {
    const meta = await repo.saveReport({ id: 'count-zero', timestamp: 1 }, undefined);
    expect(meta.totalElements).toBe(0);
  });

  it('getReportElements returns [] for an unknown reportId', async () => {
    expect(await repo.getReportElements('does-not-exist')).toEqual([]);
  });

  it('overwrites the record when saving the same report.id twice (put semantics)', async () => {
    await repo.saveReport({ id: 'dup', mode: 'scan', timestamp: 1 }, [{ id: 'a' }]);
    await repo.saveReport({ id: 'dup', mode: 'record', timestamp: 2 }, [{ id: 'b' }, { id: 'c' }]);

    const reports = await repo.getReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].mode).toBe('record');
    expect(reports[0].totalElements).toBe(2);
    expect(await repo.getReportElements('dup')).toEqual([{ id: 'b' }, { id: 'c' }]);
  });

  it('does not mutate the caller-supplied report object', async () => {
    const report = { id: 'immut', timestamp: 1, elements: [{ id: 'x' }] };
    await repo.saveReport(report, [{ id: 'y' }]);
    // saveReport shallow-clones before deleting `elements`, so the original keeps it.
    expect(report.elements).toEqual([{ id: 'x' }]);
  });
});

// ---------------------------------------------------------------------------
// deleteReport / clearAllReports
// ---------------------------------------------------------------------------

describe('deleteReport / clearAllReports', () => {
  it('deleteReport removes the report metadata AND its elements', async () => {
    await repo.saveReport({ id: 'keep', timestamp: 1 }, [{ id: 'k' }]);
    await repo.saveReport({ id: 'drop', timestamp: 2 }, [{ id: 'd' }]);

    await repo.deleteReport('drop');

    const reports = await repo.getReports();
    expect(reports.map((r) => r.id)).toEqual(['keep']);
    // elements for the deleted report are gone too.
    expect(await repo.getReportElements('drop')).toEqual([]);
    // the surviving report's elements are untouched.
    expect(await repo.getReportElements('keep')).toEqual([{ id: 'k' }]);
  });

  it('deleteReport on an unknown id is a no-op (no throw)', async () => {
    await repo.saveReport({ id: 'still-here', timestamp: 1 }, []);
    await expect(repo.deleteReport('ghost')).resolves.toBeUndefined();
    expect((await repo.getReports()).map((r) => r.id)).toEqual(['still-here']);
  });

  it('clearAllReports empties both reports and elements stores', async () => {
    await repo.saveReport({ id: 'a', timestamp: 1 }, [{ id: '1' }]);
    await repo.saveReport({ id: 'b', timestamp: 2 }, [{ id: '2' }]);

    await repo.clearAllReports();

    expect(await repo.getReports()).toEqual([]);
    expect(await repo.getReportElements('a')).toEqual([]);
    expect(await repo.getReportElements('b')).toEqual([]);
  });

  it('clearAllReports on an empty DB resolves cleanly', async () => {
    await expect(repo.clearAllReports()).resolves.toBeUndefined();
    expect(await repo.getReports()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AI tests store
// ---------------------------------------------------------------------------

describe('saveAiTest / getAiTests / deleteAiTest', () => {
  it('stores stepsText/transcript/spec/success and round-trips them', async () => {
    const record = {
      stepsText: 'click login\nfill email',
      transcript: [{ role: 'assistant', text: 'ok' }],
      spec: "import { test } from '@playwright/test';",
      success: true,
    };
    const saved = await repo.saveAiTest(record);

    expect(saved.stepsText).toBe(record.stepsText);
    expect(saved.transcript).toEqual(record.transcript);
    expect(saved.spec).toBe(record.spec);
    expect(saved.success).toBe(true);

    const tests = await repo.getAiTests();
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({
      stepsText: record.stepsText,
      spec: record.spec,
      success: true,
    });
  });

  it('generates an id when the record has none', async () => {
    const saved = await repo.saveAiTest({ stepsText: 'x', success: false });
    expect(typeof saved.id).toBe('string');
    expect(saved.id).toMatch(/^ait_\d+_[a-z0-9]+$/);
  });

  it('preserves a caller-supplied id', async () => {
    const saved = await repo.saveAiTest({ id: 'my-fixed-id', stepsText: 'x' });
    expect(saved.id).toBe('my-fixed-id');
    const tests = await repo.getAiTests();
    expect(tests.find((t) => t.id === 'my-fixed-id')).toBeTruthy();
  });

  it('adds a timestamp when missing and preserves a supplied one', async () => {
    const before = Date.now();
    const auto = await repo.saveAiTest({ stepsText: 'auto-ts' });
    expect(typeof auto.timestamp).toBe('number');
    expect(auto.timestamp).toBeGreaterThanOrEqual(before);

    const fixed = await repo.saveAiTest({ stepsText: 'fixed-ts', timestamp: 12345 });
    expect(fixed.timestamp).toBe(12345);
  });

  it('records success:false faithfully (not coerced to a default)', async () => {
    const saved = await repo.saveAiTest({ stepsText: 'failing', success: false });
    expect(saved.success).toBe(false);
    const fetched = (await repo.getAiTests()).find((t) => t.id === saved.id);
    expect(fetched.success).toBe(false);
  });

  it('returns ai tests sorted by timestamp descending', async () => {
    await repo.saveAiTest({ id: 't-old', stepsText: 'o', timestamp: 100 });
    await repo.saveAiTest({ id: 't-new', stepsText: 'n', timestamp: 300 });
    await repo.saveAiTest({ id: 't-mid', stepsText: 'm', timestamp: 200 });

    const tests = await repo.getAiTests();
    expect(tests.map((t) => t.id)).toEqual(['t-new', 't-mid', 't-old']);
  });

  it('deleteAiTest removes only the targeted record', async () => {
    await repo.saveAiTest({ id: 'a', stepsText: '1', timestamp: 1 });
    await repo.saveAiTest({ id: 'b', stepsText: '2', timestamp: 2 });

    await repo.deleteAiTest('a');

    const tests = await repo.getAiTests();
    expect(tests.map((t) => t.id)).toEqual(['b']);
  });

  it('deleteAiTest on an unknown id is a no-op', async () => {
    await repo.saveAiTest({ id: 'present', stepsText: 'x', timestamp: 1 });
    await expect(repo.deleteAiTest('absent')).resolves.toBeUndefined();
    expect((await repo.getAiTests()).map((t) => t.id)).toEqual(['present']);
  });

  it('getAiTests returns [] when the store is empty', async () => {
    expect(await repo.getAiTests()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// settings store
// ---------------------------------------------------------------------------

describe('getSettings / saveSettings', () => {
  it('round-trips an arbitrary settings value under the app_settings key', async () => {
    const value = { captureClicks: true, theme: 'dark', nested: { a: 1 } };
    await repo.saveSettings(value);
    expect(await repo.getSettings()).toEqual(value);
  });

  it('overwrites the previous settings value (single record)', async () => {
    await repo.saveSettings({ v: 1 });
    await repo.saveSettings({ v: 2 });
    expect(await repo.getSettings()).toEqual({ v: 2 });
  });

  it('saveSettings(null) persists null, and getSettings returns null for it', async () => {
    await repo.saveSettings(null);
    // rec exists but rec.value is null -> null ?? null -> null.
    expect(await repo.getSettings()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// attribute profiles
// ---------------------------------------------------------------------------

describe('getAllProfiles / mergeProfiles', () => {
  it('mergeProfiles stores each domain profile, getAllProfiles returns a domain-keyed object', async () => {
    await repo.mergeProfiles({
      'example.com': { learned: ['data-x'] },
      'foo.org': { learned: ['data-y'] },
    });

    const all = await repo.getAllProfiles();
    expect(all['example.com']).toEqual({ learned: ['data-x'] });
    expect(all['foo.org']).toEqual({ learned: ['data-y'] });
  });

  it('mergeProfiles upserts: re-merging the same domain replaces its profile', async () => {
    await repo.mergeProfiles({ 'site.com': { learned: ['old'] } });
    await repo.mergeProfiles({ 'site.com': { learned: ['new'] } });

    const all = await repo.getAllProfiles();
    expect(all['site.com']).toEqual({ learned: ['new'] });
  });

  it('mergeProfiles is a no-op for null / non-object / empty inputs', async () => {
    await expect(repo.mergeProfiles(null)).resolves.toBeUndefined();
    await expect(repo.mergeProfiles(undefined)).resolves.toBeUndefined();
    await expect(repo.mergeProfiles('nope')).resolves.toBeUndefined();
    await expect(repo.mergeProfiles({})).resolves.toBeUndefined();
    // Nothing should have been written.
    expect(await repo.getAllProfiles()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// usage estimate
// ---------------------------------------------------------------------------

describe('estimateUsage', () => {
  afterEach(() => {
    // remove any navigator.storage we stubbed
    if (Object.getOwnPropertyDescriptor(navigator, 'storage')?.configurable) {
      delete navigator.storage;
    }
  });

  it('returns { usage, quota } from navigator.storage.estimate()', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage: 1234, quota: 9999 }) },
    });
    expect(await repo.estimateUsage()).toEqual({ usage: 1234, quota: 9999 });
  });

  it('coerces missing usage/quota fields to 0', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({}) },
    });
    expect(await repo.estimateUsage()).toEqual({ usage: 0, quota: 0 });
  });

  it('returns zeros when estimate() rejects', async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => {
          throw new Error('denied');
        },
      },
    });
    expect(await repo.estimateUsage()).toEqual({ usage: 0, quota: 0 });
  });

  it('returns zeros when navigator.storage is unavailable', async () => {
    if (Object.getOwnPropertyDescriptor(navigator, 'storage')?.configurable) {
      delete navigator.storage;
    }
    // jsdom may or may not provide navigator.storage; force-undefine for this case.
    Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
    expect(await repo.estimateUsage()).toEqual({ usage: 0, quota: 0 });
  });
});

// ---------------------------------------------------------------------------
// schema / store reachability (the v2 upgrade creates all stores)
// ---------------------------------------------------------------------------

describe('schema reachability (onupgradeneeded created every store)', () => {
  it('all five stores are usable: reports, elements, settings, profiles, ai_tests', async () => {
    // Exercising each public path proves the corresponding object store exists;
    // a missing store would throw NotFoundError on transaction open.
    await expect(repo.saveReport({ id: 's', timestamp: 1 }, [{ id: 'e' }])).resolves.toBeTruthy();
    await expect(repo.getReportElements('s')).resolves.toEqual([{ id: 'e' }]);
    await expect(repo.saveSettings({ ok: true })).resolves.toBeUndefined();
    await expect(repo.getSettings()).resolves.toEqual({ ok: true });
    await expect(repo.mergeProfiles({ d: { learned: [] } })).resolves.toBeUndefined();
    await expect(repo.getAllProfiles()).resolves.toEqual({ d: { learned: [] } });
    await expect(repo.saveAiTest({ id: 'ai', stepsText: 'x', timestamp: 1 })).resolves.toBeTruthy();
    await expect(repo.getAiTests()).resolves.toHaveLength(1);
  });

  it('the timestamp index on reports does not interfere with metadata round-trip', async () => {
    // reports has a by_timestamp index; saving + reading back must still work.
    await repo.saveReport({ id: 'idx', timestamp: 777, mode: 'scan' }, []);
    const reports = await repo.getReports();
    expect(reports.find((r) => r.id === 'idx').timestamp).toBe(777);
  });
});
