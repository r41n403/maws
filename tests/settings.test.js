'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Create a temp dir and redirect HOME so the module picks it up
// Must happen before require('../src/main/settings')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'maws-settings-test-'));
const ORIG_HOME  = os.homedir;
os.homedir = () => TEST_HOME;

// Now require — SETTINGS_FILE will be built from TEST_HOME
const settings = require('../src/main/settings');

afterEach(() => {
  // Remove the settings file between tests so state doesn't bleed
  const file = path.join(TEST_HOME, 'Library', 'Application Support', 'maws', 'settings.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

afterAll(() => {
  os.homedir = ORIG_HOME;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('settings.load', () => {
  it('returns defaults when no file exists', () => {
    const s = settings.load();
    expect(s.lockEnabled).toBe(false);
    expect(s.lockMethod).toBe('touchid');
    expect(s.lockTimeout).toBe(0);
    expect(s.passwordHash).toBeNull();
    expect(s.passwordSalt).toBeNull();
  });

  it('merges saved values with defaults', () => {
    settings.save({ lockEnabled: true, lockTimeout: 15 });
    const s = settings.load();
    expect(s.lockEnabled).toBe(true);
    expect(s.lockTimeout).toBe(15);
    expect(s.lockMethod).toBe('touchid'); // default still present
  });
});

describe('settings.setPassword / verifyPassword', () => {
  it('returns error for passwords shorter than 4 characters', () => {
    const result = settings.setPassword('abc');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/4 characters/);
  });

  it('stores a hashed password and verifies correctly', () => {
    const set = settings.setPassword('correct-horse');
    expect(set.ok).toBe(true);
    expect(settings.verifyPassword('correct-horse')).toBe(true);
    expect(settings.verifyPassword('wrong-password')).toBe(false);
  });

  it('never stores the plain-text password', () => {
    settings.setPassword('my-secret');
    const s = settings.load();
    expect(s.passwordHash).not.toContain('my-secret');
    expect(typeof s.passwordSalt).toBe('string');
  });

  it('returns false when no password has been set', () => {
    expect(settings.verifyPassword('anything')).toBe(false);
  });
});

describe('settings.save', () => {
  it('persists a partial patch without overwriting other values', () => {
    settings.setPassword('initial-pass');
    settings.save({ lockEnabled: true, lockTimeout: 30 });

    const s = settings.load();
    expect(s.lockEnabled).toBe(true);
    expect(s.lockTimeout).toBe(30);
    expect(s.passwordHash).not.toBeNull();
  });
});

describe('settings.clearPassword', () => {
  it('removes the password hash and salt', () => {
    settings.setPassword('to-be-cleared');
    settings.clearPassword();
    const s = settings.load();
    expect(s.passwordHash).toBeNull();
    expect(s.passwordSalt).toBeNull();
    expect(settings.verifyPassword('to-be-cleared')).toBe(false);
  });
});
