'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, protocol, Menu, ipcMain, shell, screen } = require('electron');
const log = require('electron-log');

if (app.isPackaged) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'browsers');
}

const { registerIpcHandlers } = require('./ipc-handlers');
const { registerProtocolHandler } = require('./protocol-handler');
const { shutdownPlaywright } = require('./playwright-manager');
const { stopRecordSession } = require('./record-manager');
const IPC = require('./ipc-channels');

app.enableSandbox();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow = null;
let _handlersRegistered = false;
let _windowTitleListenerRegistered = false;

function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
          },
        ]
      : [
          {
            label: 'File',
            submenu: [{ role: 'quit', label: 'Exit' }],
          },
        ]),
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+\\',
          click: () => {
            BrowserWindow.getFocusedWindow()?.webContents.send(IPC.MENU_ACTION, 'toggle-sidebar');
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];

  if (!app.isPackaged) {
    template.push({
      label: 'Developer',
      submenu: [{ role: 'toggleDevTools' }, { role: 'reload' }],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('ready', () => {
  log.initialize({ preload: true });
  log.info('App ready — initialising window and handlers');

  const isSmokeTest = process.argv.includes('--smoke-test');
  if (isSmokeTest) {
    const candidates = [
      path.join(__dirname, 'tracker-bundle.js'),
      path.join(process.cwd(), 'dist', 'tracker-bundle.js'),
    ];
    const bundleFound = candidates.some((c) => {
      try {
        return fs.existsSync(c);
      } catch {
        return false;
      }
    });
    if (!bundleFound) {
      console.log('[smoke-test] FAIL: tracker-bundle.js not found in candidate paths:');
      for (const c of candidates) {
        console.log(`  ${c}`);
      }
      app.exit(1);
      return;
    }
    const version = app.getVersion();
    if (!version || typeof version !== 'string' || version.trim() === '') {
      console.log('[smoke-test] FAIL: app.getVersion() returned empty or invalid string');
      app.exit(1);
      return;
    }
    console.log(`[smoke-test] PASS: version=${version}`);
    app.quit();
    return;
  }

  buildApplicationMenu();

  if (!_windowTitleListenerRegistered) {
    ipcMain.on(IPC.SET_WINDOW_TITLE, (event, title) => {
      if (typeof title !== 'string') {
        return;
      }
      BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
    });
    _windowTitleListenerRegistered = true;
  }

  registerProtocolHandler();

  mainWindow = createMainWindow();

  if (!_handlersRegistered) {
    registerIpcHandlers(mainWindow);
    _handlersRegistered = true;
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
});

function _stateFilePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function _loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(_stateFilePath(), 'utf8'));
  } catch {
    return null;
  }
}

function _saveWindowState(win) {
  try {
    const b = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(
      _stateFilePath(),
      JSON.stringify({
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        maximized: win.isMaximized(),
      })
    );
  } catch (err) {
    log.error('Error saving window state', { err: err.message });
  }
}

function _halfScreenBounds() {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const width = Math.max(900, Math.floor(wa.width / 2));
    const height = Math.max(600, Math.floor(wa.height / 2));
    const x = wa.x + Math.floor((wa.width - width) / 2);
    const y = wa.y + Math.floor((wa.height - height) / 2);
    return { x, y, width, height };
  } catch {
    return null;
  }
}

function _attachPeriodicStateSave(win) {
  let _saveTimer = null;
  const schedSave = () => {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => _saveWindowState(win), 800);
  };
  win.on('resize', schedSave);
  win.on('move', schedSave);
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
    title: 'Agentic Test Automation',
    backgroundColor: '#111827',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 14 } }
      : {}),
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== 'app://./index.html' && !targetUrl.startsWith('app://')) {
      event.preventDefault();
      log.warn('[BOOT] Blocked navigation away from app shell', { targetUrl });
    }
  });

  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  let _mainWindowShown = false;
  const applyBoundsAndShow = () => {
    if (_mainWindowShown || win.isDestroyed()) {
      return;
    }
    _mainWindowShown = true;

    const savedState = _loadWindowState();
    if (!savedState) {
      const half = _halfScreenBounds();
      if (half) {
        win.setBounds(half);
      }
      win.maximize();
    } else {
      if (savedState.width && savedState.height) {
        win.setSize(savedState.width, savedState.height);
      }
      if (savedState.x != null && savedState.y != null) {
        win.setPosition(savedState.x, savedState.y);
      }
      if (savedState.maximized) {
        win.maximize();
      }
    }
    win.show();
  };

  win.once('ready-to-show', applyBoundsAndShow);

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    log.error('[BOOT] Main frame failed to load', { errorCode, errorDescription, validatedURL });
    applyBoundsAndShow();
  });

  const _showFallbackTimer = setTimeout(() => {
    if (win.isDestroyed() || win.isVisible()) {
      return;
    }
    log.warn('[BOOT] ready-to-show did not fire — showing window anyway');
    applyBoundsAndShow();
  }, 8000);
  win.once('show', () => clearTimeout(_showFallbackTimer));

  win.on('close', () => _saveWindowState(win));
  _attachPeriodicStateSave(win);

  win.loadURL('app://./index.html');

  return win;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createMainWindow();
  }
});

// Electron does NOT await an async before-quit handler — it proceeds to tear the
// process down, which can orphan headed browser processes mid-shutdown. So on the
// first quit we cancel the quit, run cleanup to completion, then exit. A guard
// flag prevents the re-entrant before-quit (from app.quit()) from looping.
let _quitting = false;
app.on('before-quit', (event) => {
  if (_quitting) {
    return;
  }
  _quitting = true;
  event.preventDefault();
  log.info('App quitting — stopping record session and shutting down Playwright');
  Promise.allSettled([
    stopRecordSession().catch((err) => log.warn('Record session stop error during quit', { err: err.message })),
    shutdownPlaywright().catch((err) => log.warn('Playwright shutdown error during quit', { err: err.message })),
  ]).finally(() => {
    // Re-issue the quit. With _quitting set, the handler above returns without
    // preventing it, so the normal shutdown path (window close → state save →
    // exit) runs to completion.
    app.quit();
  });
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process', err);
});
