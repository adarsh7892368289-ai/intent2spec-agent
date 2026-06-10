'use strict';

// IndexedDB persistence for the desktop element tracker. Mirrors the data the
// Chrome extension kept in chrome.storage.local, reorganized into object stores:
//   - elements:  one record per captured/scanned element (indexed by mode + session)
//   - stats:     per-mode counters (keyed by mode)
//   - settings:  single settings record
//   - profiles:  domain attribute profiles (keyed by domain)
// Replaces background/storage-controller.js + memory-manager.js.

const DB_NAME = 'element_tracker_db';
const DB_VERSION = 1;

const STORE_ELEMENTS = 'elements';
const STORE_STATS = 'stats';
const STORE_SETTINGS = 'settings';
const STORE_PROFILES = 'profiles';

const SETTINGS_KEY = 'app_settings';

let _dbPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

function openDB() {
  if (_dbPromise) {
    return _dbPromise;
  }
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      void event;
      if (!db.objectStoreNames.contains(STORE_ELEMENTS)) {
        const els = db.createObjectStore(STORE_ELEMENTS, { keyPath: 'id' });
        els.createIndex('by_mode', 'mode', { unique: false });
        els.createIndex('by_session', 'sessionId', { unique: false });
        els.createIndex('by_mode_ts', ['mode', 'timestamp'], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_STATS)) {
        db.createObjectStore(STORE_STATS, { keyPath: 'mode' });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: 'domain' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

// ---- elements ---------------------------------------------------------------

// Append a batch of element records under a mode. Each record gets a stable id.
async function addElements(mode, sessionId, elements) {
  if (!Array.isArray(elements) || elements.length === 0) {
    return 0;
  }
  const db = await openDB();
  const tx = db.transaction(STORE_ELEMENTS, 'readwrite');
  const store = tx.objectStore(STORE_ELEMENTS);
  let n = 0;
  for (const el of elements) {
    const id = `${mode}_${sessionId}_${el.elementId ?? el.id ?? `${Date.now()}_${n}`}_${n}`;
    store.put({
      id,
      mode,
      sessionId,
      timestamp: el.timestamp ?? Date.now(),
      captureType: el.captureType ?? 'scan',
      element: el,
    });
    n++;
  }
  await txDone(tx);
  return n;
}

async function getElementsByMode(mode) {
  const db = await openDB();
  const tx = db.transaction(STORE_ELEMENTS, 'readonly');
  const index = tx.objectStore(STORE_ELEMENTS).index('by_mode');
  const records = await requestToPromise(index.getAll(mode));
  return (records ?? []).map((r) => r.element);
}

async function countElementsByMode(mode) {
  const db = await openDB();
  const tx = db.transaction(STORE_ELEMENTS, 'readonly');
  const index = tx.objectStore(STORE_ELEMENTS).index('by_mode');
  return requestToPromise(index.count(mode));
}

async function clearElementsByMode(mode) {
  const db = await openDB();
  const tx = db.transaction(STORE_ELEMENTS, 'readwrite');
  const index = tx.objectStore(STORE_ELEMENTS).index('by_mode');
  const keys = await requestToPromise(index.getAllKeys(mode));
  const store = tx.objectStore(STORE_ELEMENTS);
  for (const key of keys ?? []) {
    store.delete(key);
  }
  await txDone(tx);
  return (keys ?? []).length;
}

async function clearAllElements() {
  const db = await openDB();
  const tx = db.transaction(STORE_ELEMENTS, 'readwrite');
  tx.objectStore(STORE_ELEMENTS).clear();
  await txDone(tx);
}

// ---- stats ------------------------------------------------------------------

async function getStats(mode) {
  const db = await openDB();
  const tx = db.transaction(STORE_STATS, 'readonly');
  const rec = await requestToPromise(tx.objectStore(STORE_STATS).get(mode));
  return rec ?? { mode, counts: {} };
}

async function getAllStats() {
  const db = await openDB();
  const tx = db.transaction(STORE_STATS, 'readonly');
  const recs = await requestToPromise(tx.objectStore(STORE_STATS).getAll());
  const out = {};
  for (const r of recs ?? []) {
    out[r.mode] = r;
  }
  return out;
}

async function setStats(mode, counts) {
  const db = await openDB();
  const tx = db.transaction(STORE_STATS, 'readwrite');
  tx.objectStore(STORE_STATS).put({ mode, counts, lastUpdated: Date.now() });
  await txDone(tx);
}

async function clearStats(mode) {
  const db = await openDB();
  const tx = db.transaction(STORE_STATS, 'readwrite');
  tx.objectStore(STORE_STATS).delete(mode);
  await txDone(tx);
}

// ---- settings ---------------------------------------------------------------

async function getSettings() {
  const db = await openDB();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const rec = await requestToPromise(tx.objectStore(STORE_SETTINGS).get(SETTINGS_KEY));
  return rec?.value ?? null;
}

async function saveSettings(value) {
  const db = await openDB();
  const tx = db.transaction(STORE_SETTINGS, 'readwrite');
  tx.objectStore(STORE_SETTINGS).put({ key: SETTINGS_KEY, value });
  await txDone(tx);
}

// ---- attribute profiles -----------------------------------------------------

async function getAllProfiles() {
  const db = await openDB();
  const tx = db.transaction(STORE_PROFILES, 'readonly');
  const recs = await requestToPromise(tx.objectStore(STORE_PROFILES).getAll());
  const out = {};
  for (const r of recs ?? []) {
    out[r.domain] = r.profile;
  }
  return out;
}

async function mergeProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object') {
    return;
  }
  const entries = Object.entries(profiles);
  if (entries.length === 0) {
    return;
  }
  const db = await openDB();
  const tx = db.transaction(STORE_PROFILES, 'readwrite');
  const store = tx.objectStore(STORE_PROFILES);
  for (const [domain, profile] of entries) {
    store.put({ domain, profile });
  }
  await txDone(tx);
}

// ---- usage ------------------------------------------------------------------

async function estimateUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage ?? 0, quota: quota ?? 0 };
    } catch {
      return { usage: 0, quota: 0 };
    }
  }
  return { usage: 0, quota: 0 };
}

export default {
  addElements,
  getElementsByMode,
  countElementsByMode,
  clearElementsByMode,
  clearAllElements,
  getStats,
  getAllStats,
  setStats,
  clearStats,
  getSettings,
  saveSettings,
  getAllProfiles,
  mergeProfiles,
  estimateUsage,
};
