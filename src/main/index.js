'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');

const path = require('path');
const awsAuth = require('./aws-auth');
const featureRegistry = require('./feature-registry');
const audit = require('./audit-logger');
const health = require('./health-checker');
const costChecker = require('./cost-checker');
const settings       = require('./settings');
const { validateImportBuffer } = require('./file-validator');

const isDev = process.argv.includes('--dev');

app.setName('MAWS');
app.setAboutPanelOptions({
  applicationName:    'MAWS',
  applicationVersion: app.getVersion(),
  copyright:          'MIT License',
  credits:            'Connor Maher — connor@cmitservices.com\nhttps://github.com/r41n403/maws',
});

// Enforce single instance — focus existing window if already running
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  if (app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, '../../assets/icon.png'));
    } catch (e) {
      // icon not available in packaged build — safe to ignore
    }
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../../assets/icon.png'),
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// Restrict webview navigation to AWS domains only.
// Any link that tries to leave AWS opens in the real browser instead.
const AWS_ORIGIN = /^https:\/\/([\w-]+\.)?(amazonaws\.com|aws\.amazon\.com|console\.aws\.amazon\.com|signin\.aws\.amazon\.com|awsapps\.com)(\/|$)/;

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    contents.on('will-navigate', (event, url) => {
      if (!AWS_ORIGIN.test(url)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
    // Block new windows from opening inside the webview
    contents.setWindowOpenHandler(({ url }) => {
      if (AWS_ORIGIN.test(url)) return { action: 'allow' };
      shell.openExternal(url);
      return { action: 'deny' };
    });
    // ERR_ABORTED (-3) is expected during OAuth redirects — one navigation
    // supersedes another. Suppress it to avoid noisy console output.
    contents.on('did-fail-load', (_e, errorCode) => {
      if (errorCode === -3) return;
    });
  }
  // Prevent the main window itself from navigating away from the local file
  if (contents.getType() === 'mainFrame') {
    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
  }
});

app.whenReady().then(async () => {
  await awsAuth.restoreSession();
  createWindow();
  featureRegistry.loadAll(ipcMain);
  health.startPolling();

  // Forward session-expired events from auth module to the renderer
  awsAuth.authEvents.on('session-expired', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth:session-expired');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Auth IPC ─────────────────────────────────────────────────────────────────

ipcMain.handle('auth:list-profiles', async () => {
  return awsAuth.listProfiles();
});

ipcMain.handle('auth:login-sso', async (_event, profileName) => {
  return awsAuth.loginSSO(profileName);
});

ipcMain.handle('auth:login-profile', async (_event, profileName) => {
  return awsAuth.loginProfile(profileName);
});

ipcMain.handle('auth:get-identity', async () => {
  return awsAuth.getIdentity();
});

ipcMain.handle('auth:logout', async () => {
  return awsAuth.logout();
});

ipcMain.handle('auth:get-session', async () => {
  return awsAuth.getSession();
});

ipcMain.handle('auth:refresh', async () => {
  return awsAuth.refreshSession();
});

ipcMain.handle('auth:create-sso-profile', async (_event, opts) => {
  return awsAuth.createSSOProfile(opts);
});

ipcMain.handle('auth:create-access-key-profile', async (_event, opts) => {
  return awsAuth.createAccessKeyProfile(opts);
});

ipcMain.handle('auth:get-console-federation-url', async (_event, destination) => {
  return awsAuth.getConsoleFederationUrl(destination);
});

// ── Feature IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('features:list', async () => {
  return featureRegistry.list();
});

// ── Health IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('health:get-status', async () => {
  return health.getStatus();
});

// ── Audit IPC ────────────────────────────────────────────────────────────────

ipcMain.handle('audit:get-entries', async (_event, filter) => {
  return audit.getEntries(filter || {});
});

ipcMain.handle('audit:log', async (_event, opts) => {
  return audit.log(opts);
});

ipcMain.handle('audit:export-json', async () => {
  return audit.exportJSON();
});

ipcMain.handle('audit:export-csv', async () => {
  return audit.exportCSV();
});

ipcMain.handle('audit:get-info', async () => {
  return audit.getInfo();
});

// ── Settings / Lock IPC ───────────────────────────────────────────────────────

ipcMain.handle('settings:get', async () => {
  const s = settings.load();
  // Never send hashes to renderer
  return {
    lockEnabled:        s.lockEnabled,
    lockMethod:         s.lockMethod,
    lockTimeout:        s.lockTimeout,
    hasPassword:        !!s.passwordHash,
    autoRefreshEnabled: s.autoRefreshEnabled,
    autoRefreshHours:   s.autoRefreshHours,
  };
});

ipcMain.handle('settings:save', async (_event, patch) => {
  const allowed = ['lockEnabled', 'lockMethod', 'lockTimeout', 'autoRefreshEnabled', 'autoRefreshHours'];
  const safe = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  settings.save(safe);
  return { ok: true };
});

ipcMain.handle('settings:set-password', async (_event, password) => {
  return settings.setPassword(password);
});

ipcMain.handle('settings:clear-password', async () => {
  settings.clearPassword();
  return { ok: true };
});

ipcMain.handle('settings:verify-password', async (_event, password) => {
  return { ok: settings.verifyPassword(password) };
});

ipcMain.handle('settings:prompt-touchid', async () => {
  const { systemPreferences } = require('electron');
  if (!systemPreferences.canPromptTouchID())
    return { ok: false, error: 'Touch ID is not available on this device.' };
  try {
    await systemPreferences.promptTouchID('Unlock Maws');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:touchid-available', async () => {
  const { systemPreferences } = require('electron');
  return { available: systemPreferences.canPromptTouchID() };
});

// ── Utility IPC ───────────────────────────────────────────────────────────────

ipcMain.handle('util:import-file', async (_event, { filters, type }) => {
  const { dialog } = require('electron');
  const os  = require('os');
  const fs  = require('fs');

  // Hard limits — enforced in the main process, cannot be bypassed by the renderer
  const MAX_BYTES = 512 * 1024; // 512 KB — well above any real script or CFN template

  const picked = await dialog.showOpenDialog(mainWindow, {
    title:       'Import File',
    defaultPath: path.join(os.homedir(), 'Downloads'),
    properties:  ['openFile'],
    filters:     filters || [{ name: 'All Files', extensions: ['*'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

  // Resolve the real path to block symlink traversal outside user-accessible dirs
  const rawPath = picked.filePaths[0];
  let filePath;
  try {
    filePath = fs.realpathSync(rawPath);
  } catch {
    filePath = rawPath; // realpathSync fails if file doesn't exist — shouldn't happen here
  }

  // ── 1. Size check (before reading into memory) ────────────────────────────
  let stats;
  try { stats = fs.statSync(filePath); } catch (e) {
    return { ok: false, error: `Cannot access file: ${e.message}` };
  }
  if (!stats.isFile()) return { ok: false, error: 'Selected path is not a regular file.' };
  if (stats.size === 0)  return { ok: false, error: 'File is empty.' };
  if (stats.size > MAX_BYTES) {
    const kb    = (stats.size  / 1024).toFixed(1);
    const maxKb = (MAX_BYTES   / 1024).toFixed(0);
    return { ok: false, error: `File is too large (${kb} KB). Maximum allowed size is ${maxKb} KB.` };
  }

  // ── 2. Read as raw buffer (no charset decoding yet) ───────────────────────
  let buffer;
  try { buffer = fs.readFileSync(filePath); } catch (e) {
    return { ok: false, error: `Failed to read file: ${e.message}` };
  }

  // ── 3-6. Delegate content validation to the testable helper ──────────────
  const validation = validateImportBuffer(buffer, type);
  if (!validation.ok) return validation;

  return { ok: true, content: validation.content, filePath };
});

ipcMain.handle('shell:open-external', async (_event, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('shell:open-path', async (_event, filePath) => {
  const err = await shell.openPath(filePath);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('shell:show-item-in-folder', (_event, filePath) => {
  shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle('billing:get-current-month-cost', async () => {
  const session = awsAuth.getSession();
  if (!session) return { ok: false, error: 'Not authenticated' };
  const provider = awsAuth.getCredentialProvider();
  if (!provider) return { ok: false, error: 'No credential provider' };
  try {
    const credentials = await provider();
    return await costChecker.getCurrentMonthCost(credentials);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('util:get-version', (event) => {
  event.returnValue = app.getVersion();
});

ipcMain.handle('util:get-public-ip', async () => {
  return new Promise((resolve) => {
    const https = require('https');
    https.get('https://checkip.amazonaws.com', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: true, ip: data.trim() }));
    }).on('error', () => resolve({ ok: false, ip: null }));
  });
});

// Fetch authoritative time from Cloudflare (primary) or worldtimeapi.org (fallback).
// Returns { ok, serverMs, localMs } so the renderer can compute an offset.
ipcMain.handle('util:get-server-time', async () => {
  const https = require('https');

  function fetchCF() {
    return new Promise((resolve, reject) => {
      const req = https.get('https://1.1.1.1/cdn-cgi/trace', { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          const match = data.match(/ts=([\d.]+)/);
          if (match) resolve(Math.round(parseFloat(match[1]) * 1000));
          else reject(new Error('ts field not found'));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  function fetchWTA() {
    return new Promise((resolve, reject) => {
      const req = https.get('https://worldtimeapi.org/api/timezone/Etc/UTC', { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.unixtime * 1000);
          } catch { reject(new Error('parse error')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  const localMs = Date.now();
  try {
    const serverMs = await fetchCF().catch(() => fetchWTA());
    return { ok: true, serverMs, localMs };
  } catch (e) {
    return { ok: false, serverMs: null, localMs, error: e.message };
  }
});
