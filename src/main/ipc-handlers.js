'use strict';

const { ipcMain, app, dialog } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');

const CH = require('./ipc-channels');
const playwrightManager = require('./playwright-manager');
const recordManager = require('./record-manager');
const aiManager = require('./ai-manager');
const { isSafeBasename } = require('@security/guards.js');

let _mainWindow = null;

const _cancelRegistry = new Map();

function _registerOp(operationId, kind) {
  if (typeof operationId === 'string' && operationId) {
    _cancelRegistry.set(operationId, { cancelled: false, kind });
  }
}

function _unregisterOp(operationId) {
  if (typeof operationId === 'string' && operationId) {
    _cancelRegistry.delete(operationId);
  }
}

function _isCancelled(operationId) {
  return () => !!(operationId && _cancelRegistry.get(operationId)?.cancelled);
}

function _pushToWindow(channel, payload) {
  if (_mainWindow?.webContents && !_mainWindow.webContents.isDestroyed()) {
    _mainWindow.webContents.send(channel, payload);
  }
}

const _aiAborts = new Map(); // operationId -> AbortController

function registerIpcHandlers(mainWindow) {
  _mainWindow = mainWindow;
  _registerMetaHandlers();
  _registerCancelHandlers();
  _registerScanHandlers();
  _registerRecordHandlers();
  _registerFileHandlers();
  _registerAiHandlers();
}

function _registerAiHandlers() {
  ipcMain.handle(CH.AI_CHECK_CLI, () => {
    try {
      return aiManager.detectClaudeCli();
    } catch (err) {
      return { ok: false, error: err?.message };
    }
  });

  ipcMain.handle(CH.AI_RUN, async (event, params = {}) => {
    const { operationId, startUrl, stepsText, browserType, reportElements, reportMeta } = params;
    const controller = new AbortController();
    if (operationId) {
      _aiAborts.set(operationId, controller);
    }
    const onEvent = (ev) => _pushToWindow(CH.AI_PROGRESS, { operationId, event: ev });

    try {
      const result = await aiManager.runGeneration({
        startUrl,
        stepsText,
        browserType,
        reportElements: reportElements ?? null,
        reportMeta: reportMeta ?? null,
        onEvent,
        signal: controller.signal,
      });
      return { success: result.success, result };
    } catch (err) {
      log.error('AI_RUN failed', { error: err?.message, code: err?.code });
      return { success: false, error: err?.message, code: err?.code ?? null };
    } finally {
      if (operationId) {
        _aiAborts.delete(operationId);
      }
    }
  });

  ipcMain.handle(CH.AI_CANCEL, (event, { operationId } = {}) => {
    const c = _aiAborts.get(operationId);
    if (c) {
      c.abort();
    }
    return { acknowledged: true };
  });
}

function _registerMetaHandlers() {
  ipcMain.handle(CH.GET_VERSION, () => app.getVersion());

  ipcMain.handle(CH.GET_HOST_MEMORY, () => ({
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  }));

  ipcMain.handle(CH.GET_AVAILABLE_BROWSERS, async (event, opts = {}) => {
    let browserDetector;
    try {
      browserDetector = require('./browser-detector');
    } catch (err) {
      log.error('GET_AVAILABLE_BROWSERS: failed to load browser-detector', { error: err.message });
      return { success: false, error: err.message };
    }
    try {
      const { browsers, detectedAt } = await browserDetector.detectBrowsers({
        refresh: Boolean(opts && opts.refresh),
      });
      return { success: true, browsers, detectedAt };
    } catch (err) {
      log.error('GET_AVAILABLE_BROWSERS failed', { error: err?.message ?? String(err) });
      return { success: false, error: err?.message ?? String(err) };
    }
  });
}

function _registerCancelHandlers() {
  ipcMain.handle(CH.CANCEL_OPERATION, (event, { operationId } = {}) => {
    const ent = _cancelRegistry.get(operationId);
    if (ent) {
      ent.cancelled = true;
    }
    return { acknowledged: true };
  });
}

function _registerScanHandlers() {
  ipcMain.handle(CH.SCAN_PAGE, async (event, params = {}) => {
    const { url, filters, mode, settings, profiles, browser, operationId } = params;
    log.info('SCAN_PAGE', { url, mode, filters, browserType: browser?.browserType });

    _registerOp(operationId, 'scan');
    const sendProgress = (label, pct) => _pushToWindow(CH.SCAN_PROGRESS, { label, pct, operationId });

    try {
      const result = await playwrightManager.runScan({
        url,
        browser,
        filters,
        mode,
        settings,
        profiles,
        onProgress: sendProgress,
        isCancelled: _isCancelled(operationId),
      });
      return { success: true, result };
    } catch (error) {
      if (error?.code === 'CANCELLED') {
        return { success: false, cancelled: true };
      }
      const msg = error?.message || String(error);
      log.error('SCAN_PAGE failed', { error: msg, code: error?.code });
      return { success: false, error: msg, code: error?.code ?? null };
    } finally {
      _unregisterOp(operationId);
    }
  });
}

function _registerRecordHandlers() {
  ipcMain.handle(CH.START_RECORD_SESSION, async (event, params = {}) => {
    const { url, mode, settings, profiles, sessionId, browser } = params;
    log.info('START_RECORD_SESSION', { url, mode, browserType: browser?.browserType });
    try {
      const result = await recordManager.startRecordSession({
        url,
        mode,
        settings,
        profiles,
        sessionId,
        browser,
        onEvent: (payload) => _pushToWindow(CH.RECORD_EVENT, payload),
        onScan: (payload) => _pushToWindow(CH.RECORD_SCAN, payload),
        onClosed: (payload) => _pushToWindow(CH.RECORD_SESSION_CLOSED, payload),
      });
      return { success: true, ...result };
    } catch (error) {
      const msg = error?.message || String(error);
      log.error('START_RECORD_SESSION failed', { error: msg, code: error?.code });
      return { success: false, error: msg, code: error?.code ?? null };
    }
  });

  ipcMain.handle(CH.STOP_RECORD_SESSION, async () => {
    try {
      return await recordManager.stopRecordSession();
    } catch (error) {
      log.error('STOP_RECORD_SESSION failed', { error: error?.message });
      return { success: false, error: error?.message };
    }
  });

  ipcMain.handle(CH.TRIGGER_RECORD_SCAN, async (event, params = {}) => {
    return recordManager.triggerRecordScan(params);
  });
}

function _registerFileHandlers() {
  // Save serialized export content to a user-chosen file. The renderer produces
  // the JSON/CSV string; main owns the dialog + disk write.
  ipcMain.handle(CH.EXPORT_FILE, async (event, { content, filename, format } = {}) => {
    const extByFormat = { csv: 'csv', json: 'json', js: 'js' };
    const ext = extByFormat[format] ?? 'json';
    const safeName = isSafeBasename(filename) ? filename : `export.${ext}`;
    // Use the file's real terminal extension for the dialog filter (e.g. .spec.js).
    const dialogExt = safeName.includes('.') ? safeName.split('.').pop() : ext;

    const { canceled, filePath } = await dialog.showSaveDialog(_mainWindow, {
      title: `Export as ${ext.toUpperCase()}`,
      defaultPath: path.join(app.getPath('downloads'), safeName),
      filters: [{ name: ext.toUpperCase(), extensions: [dialogExt] }],
    });

    if (canceled || !filePath) {
      return { success: false, reason: 'cancelled' };
    }

    try {
      await fs.promises.writeFile(filePath, String(content ?? ''), 'utf8');
      log.info('Export written', { filePath, format });
      return { success: true, filePath };
    } catch (err) {
      log.error('EXPORT_FILE write failed', { error: err.message, code: err.code });
      const reason =
        err.code === 'EACCES'
          ? 'Permission denied — choose a different location'
          : err.code === 'EBUSY'
            ? 'File is in use by another process'
            : err.message;
      return { success: false, error: reason };
    }
  });
}

module.exports = { registerIpcHandlers };
