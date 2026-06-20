'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');

const path = require('path');
const awsAuth = require('./aws-auth');
const featureRegistry = require('./feature-registry');
const audit = require('./audit-logger');
const health = require('./health-checker');
const costChecker = require('./cost-checker');
const settings = require('./settings');

const isDev = process.argv.includes('--dev');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 800,
    minHeight: 600,
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

app.whenReady().then(async () => {
  await awsAuth.restoreSession();
  createWindow();
  featureRegistry.loadAll(ipcMain);
  health.startPolling();

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
  return { lockEnabled: s.lockEnabled, lockMethod: s.lockMethod, lockTimeout: s.lockTimeout, hasPassword: !!s.passwordHash };
});

ipcMain.handle('settings:save', async (_event, patch) => {
  const allowed = ['lockEnabled', 'lockMethod', 'lockTimeout'];
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

ipcMain.handle('shell:open-external', async (_event, url) => {
  await shell.openExternal(url);
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
