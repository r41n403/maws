#!/usr/bin/env node
/**
 * Takes screenshots of every MAWS view and saves them to assets/screenshots/.
 * Run with: npm run screenshots
 *
 * Launches Electron with the real auth session (restores from Keychain),
 * navigates each view, and saves PNGs.
 */

'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

const OUT_DIR = path.join(__dirname, '../assets/screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Load real modules so the app boots fully authenticated
const awsAuth       = require('../src/main/aws-auth');
const featureRegistry = require('../src/main/feature-registry');
const audit         = require('../src/main/audit-logger');
const health        = require('../src/main/health-checker');
const costChecker   = require('../src/main/cost-checker');
const settings      = require('../src/main/settings');

// Views to capture: selector matches data-view attribute on .nav-item
const VIEWS = [
  { click: '.nav-item[data-view="auth"]',                file: 'auth.png',                label: 'Authentication' },
  { click: '.nav-item[data-view="dashboard"]',           file: 'dashboard.png',           label: 'Dashboard' },
  { click: '.nav-item[data-view="arn-scratchpad"]',      file: 'arn-scratchpad.png',      label: 'ARN Scratchpad' },
  { click: '.nav-item[data-view="resource-lister"]',     file: 'resource-lister.png',     label: 'Resource Lister' },
  { click: '.nav-item[data-view="route53"]',             file: 'route53.png',             label: 'Route53' },
  { click: '.nav-item[data-view="timestamp-converter"]', file: 'timestamp-converter.png', label: 'Timestamp Converter' },
  { click: '.nav-item[data-view="audit"]',               file: 'audit-log.png',           label: 'Audit Log' },
  { click: '.nav-item[data-view="settings"]',            file: 'settings.png',            label: 'Settings' },
];

// ── IPC handlers (same as src/main/index.js) ──────────────────────────────────
ipcMain.on('util:get-version', (e) => { e.returnValue = app.getVersion(); });

ipcMain.handle('auth:list-profiles',   async () => awsAuth.listProfiles());
ipcMain.handle('auth:login-sso',       async (_e, p) => awsAuth.loginSSO(p));
ipcMain.handle('auth:login-profile',   async (_e, p) => awsAuth.loginProfile(p));
ipcMain.handle('auth:get-identity',    async () => awsAuth.getIdentity());
ipcMain.handle('auth:get-session',     async () => awsAuth.getSession());
ipcMain.handle('auth:logout',          async () => awsAuth.logout());

ipcMain.handle('features:list', async () => featureRegistry.list());
ipcMain.handle('health:get-status', async () => health.getStatus());

ipcMain.handle('audit:get-entries', async (_e, f) => audit.getEntries(f || {}));
ipcMain.handle('audit:log',         async (_e, o) => audit.log(o));
ipcMain.handle('audit:export-json', async () => audit.exportJSON());
ipcMain.handle('audit:export-csv',  async () => audit.exportCSV());
ipcMain.handle('audit:get-info',    async () => audit.getInfo());

ipcMain.handle('settings:get',             async () => { const s = settings.load(); return { lockEnabled: s.lockEnabled, lockMethod: s.lockMethod, lockTimeout: s.lockTimeout, hasPassword: !!s.passwordHash }; });
ipcMain.handle('settings:save',            async (_e, p) => { settings.save(p); return { ok: true }; });
ipcMain.handle('settings:set-password',    async (_e, pw) => settings.setPassword(pw));
ipcMain.handle('settings:clear-password',  async () => { settings.clearPassword(); return { ok: true }; });
ipcMain.handle('settings:verify-password', async (_e, pw) => ({ ok: settings.verifyPassword(pw) }));
ipcMain.handle('settings:touchid-available', async () => {
  const { systemPreferences } = require('electron');
  return { available: systemPreferences.canPromptTouchID() };
});

ipcMain.handle('shell:open-external', async (_e, url) => shell.openExternal(url));

ipcMain.handle('billing:get-current-month-cost', async () => {
  const session = awsAuth.getSession();
  if (!session) return { ok: false, error: 'Not authenticated' };
  const provider = awsAuth.getCredentialProvider();
  if (!provider) return { ok: false, error: 'No credential provider' };
  try { return await costChecker.getCurrentMonthCost(await provider()); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('util:get-public-ip', async () => {
  return new Promise((resolve) => {
    const https = require('https');
    https.get('https://checkip.amazonaws.com', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ ok: true, ip: data.trim() }));
    }).on('error', () => resolve({ ok: false, ip: null }));
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Temporarily disable app lock so the lock screen doesn't block screenshots
  const origSettings = settings.load();
  settings.save({ lockEnabled: false });

  // Restore saved session from Keychain so views load authenticated
  await awsAuth.restoreSession();
  featureRegistry.loadAll(ipcMain);

  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../src/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));

  // Wait for app to settle
  await new Promise(r => setTimeout(r, 2000));

  // Wait for the user to log in if session is expired
  const isAuthenticated = await win.webContents.executeJavaScript(`
    (async () => {
      const session = await window.aws.getSession();
      return !!session;
    })()
  `);

  if (!isAuthenticated) {
    console.log('\n⚠️  Session expired — please log in via the app window that just opened.');
    console.log('    Waiting for authentication...\n');

    await new Promise((resolve) => {
      const check = setInterval(async () => {
        const authed = await win.webContents.executeJavaScript(`
          (async () => { const s = await window.aws.getSession(); return !!s; })()
        `).catch(() => false);
        if (authed) { clearInterval(check); resolve(); }
      }, 1000);
    });

    console.log('✓ Authenticated — capturing screenshots...\n');
    // Let the UI settle after login
    await new Promise(r => setTimeout(r, 2000));
  }

  for (const view of VIEWS) {
    await win.webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector('${view.click}');
        if (el) { el.click(); return true; }
        return false;
      })()
    `);
    await new Promise(r => setTimeout(r, 1200));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, view.file), image.toPNG());
    console.log(`✓ ${view.label} → ${view.file}`);
  }

  // Restore original lock setting
  settings.save({ lockEnabled: origSettings.lockEnabled });

  console.log('\nDone! Screenshots saved to assets/screenshots/');
  app.quit();
});
