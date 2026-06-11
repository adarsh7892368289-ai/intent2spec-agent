'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const CH = require('./ipc-channels');

function makePushBridge(channel) {
  return (callback) => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('elementTrackerAPI', {
  platform: process.platform,

  // Meta
  getVersion: () => ipcRenderer.invoke(CH.GET_VERSION),
  getAvailableBrowsers: (opts) => ipcRenderer.invoke(CH.GET_AVAILABLE_BROWSERS, opts ?? {}),
  getHostMemory: () => ipcRenderer.invoke(CH.GET_HOST_MEMORY),

  // Automated Element Scan
  scanPage: (params) => ipcRenderer.invoke(CH.SCAN_PAGE, params),
  onScanProgress: makePushBridge(CH.SCAN_PROGRESS),

  // Headed Record sessions
  startRecordSession: (params) => ipcRenderer.invoke(CH.START_RECORD_SESSION, params),
  stopRecordSession: (params) => ipcRenderer.invoke(CH.STOP_RECORD_SESSION, params),
  triggerRecordScan: (params) => ipcRenderer.invoke(CH.TRIGGER_RECORD_SCAN, params),
  onRecordEvent: makePushBridge(CH.RECORD_EVENT),
  onRecordScan: makePushBridge(CH.RECORD_SCAN),
  onRecordSessionClosed: makePushBridge(CH.RECORD_SESSION_CLOSED),

  // AI Automation (headless Claude Code)
  aiCheckCli: () => ipcRenderer.invoke(CH.AI_CHECK_CLI),
  aiRun: (params) => ipcRenderer.invoke(CH.AI_RUN, params),
  aiCancel: (payload) => ipcRenderer.invoke(CH.AI_CANCEL, payload),
  onAiProgress: makePushBridge(CH.AI_PROGRESS),

  // Cancellation
  cancelOperation: (payload) => ipcRenderer.invoke(CH.CANCEL_OPERATION, payload),

  // Export
  exportFile: (params) => ipcRenderer.invoke(CH.EXPORT_FILE, params),

  // Window / chrome
  setWindowTitle: (title) => ipcRenderer.send(CH.SET_WINDOW_TITLE, title),
  onMenuAction: makePushBridge(CH.MENU_ACTION),
  onAppNotification: makePushBridge(CH.APP_NOTIFICATION),
});
