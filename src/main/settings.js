'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const SETTINGS_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'maws', 'settings.json');

const DEFAULTS = {
  lockEnabled:  false,
  lockMethod:   'touchid', // 'touchid' | 'password'
  lockTimeout:  0,         // minutes; 0 = on launch only
  passwordHash: null,
  passwordSalt: null,
};

function load() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
  } catch {}
  return { ...DEFAULTS };
}

function save(partial) {
  const current = load();
  const next = { ...current, ...partial };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return next;
}

function setPassword(password) {
  if (!password || password.length < 4)
    return { ok: false, error: 'Password must be at least 4 characters.' };
  const salt = crypto.randomBytes(32).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  save({ passwordHash: hash, passwordSalt: salt });
  return { ok: true };
}

function verifyPassword(password) {
  const s = load();
  if (!s.passwordHash || !s.passwordSalt) return false;
  const hash = crypto.pbkdf2Sync(password, s.passwordSalt, 100000, 64, 'sha512').toString('hex');
  return hash === s.passwordHash;
}

function clearPassword() {
  save({ passwordHash: null, passwordSalt: null });
}

module.exports = { load, save, setPassword, verifyPassword, clearPassword };
