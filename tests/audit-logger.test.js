'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Real temp dir so logger can write actual files — tests stay isolated
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'maws-audit-test-'));
const ORIG_HOME  = os.homedir;
os.homedir = () => TEST_HOME;

const audit = require('../src/main/audit-logger');

afterAll(() => {
  os.homedir = ORIG_HOME;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('audit.log', () => {
  it('returns an entry with all required fields', () => {
    const e = audit.log({
      category: 'auth',
      event:    'AUTH_LOGIN_SUCCESS',
      message:  'Test login',
      result:   'success',
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    expect(e.timestamp).toBeTruthy();
    expect(e.category).toBe('auth');
    expect(e.event).toBe('AUTH_LOGIN_SUCCESS');
    expect(e.result).toBe('success');
    expect(e.actor).toBeNull();
    expect(e.account).toBeNull();
  });

  it('includes optional actor and account fields', () => {
    const e = audit.log({
      category: 'auth',
      event:    'AUTH_LOGOUT',
      message:  'User signed out',
      result:   'info',
      actor:    'arn:aws:iam::123456789012:user/rain',
      account:  '123456789012',
    });
    expect(e.actor).toBe('arn:aws:iam::123456789012:user/rain');
    expect(e.account).toBe('123456789012');
  });
});

describe('audit.getEntries', () => {
  it('returns entries with newest first', () => {
    audit.log({ category: 'feature', event: 'FIRST',  message: 'first',  result: 'info' });
    audit.log({ category: 'feature', event: 'SECOND', message: 'second', result: 'info' });
    const entries = audit.getEntries();
    const events = entries.map(e => e.event);
    const iFirst  = events.indexOf('FIRST');
    const iSecond = events.indexOf('SECOND');
    expect(iSecond).toBeLessThan(iFirst); // SECOND logged later → appears earlier (newest first)
  });

  it('filters by category', () => {
    audit.log({ category: 'console', event: 'CONSOLE_OPEN', message: 'opened', result: 'info' });
    const entries = audit.getEntries({ category: 'console' });
    expect(entries.every(e => e.category === 'console')).toBe(true);
  });

  it('filters by result', () => {
    audit.log({ category: 'auth', event: 'AUTH_FAILED', message: 'fail', result: 'failure' });
    const failures = audit.getEntries({ result: 'failure' });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every(e => e.result === 'failure')).toBe(true);
  });

  it('filters by search term', () => {
    audit.log({ category: 'auth', event: 'AUTH_LOGIN_SUCCESS', message: 'uniqueterm123 login', result: 'success' });
    const results = audit.getEntries({ search: 'uniqueterm123' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].message).toContain('uniqueterm123');
  });

  it('respects the limit option', () => {
    const entries = audit.getEntries({ limit: 2 });
    expect(entries.length).toBeLessThanOrEqual(2);
  });
});

describe('audit.exportJSON', () => {
  it('returns valid JSON array', () => {
    const json = audit.exportJSON();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe('audit.exportCSV', () => {
  it('returns a string with CSV headers', () => {
    const csv = audit.exportCSV();
    expect(csv).toContain('id,timestamp,category,event,message');
  });

  it('has the same number of rows as entries (+ header)', () => {
    const csv = audit.exportCSV();
    const entries = audit.getEntries({ limit: 50000 });
    const lines = csv.split('\n').filter(Boolean);
    expect(lines.length).toBe(entries.length + 1); // +1 for header
  });
});
