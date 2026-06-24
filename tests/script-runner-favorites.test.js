'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Redirect HOME to a temp dir before requiring the feature module
const TEST_HOME  = fs.mkdtempSync(path.join(os.tmpdir(), 'maws-sr-favs-test-'));
const ORIG_HOME  = os.homedir;
os.homedir = () => TEST_HOME;

// Mock keytar and ini — required transitively through aws-auth
jest.mock('keytar', () => ({
  getPassword: jest.fn(() => Promise.resolve(null)),
  setPassword: jest.fn(() => Promise.resolve()),
  deletePassword: jest.fn(() => Promise.resolve()),
}), { virtual: true });

jest.mock('ini', () => ({ parse: jest.fn(() => ({})) }), { virtual: true });

const feature = require('../src/features/script-runner/index.js');
const handlers = feature.handlers;

// Convenience wrappers — handlers use (_event, payload) signature
const list           = ()     => handlers['script-runner:list']();
const toggleFavorite = (id)   => handlers['script-runner:toggle-favorite'](null, { id });

const FAV_FILE = path.join(TEST_HOME, 'Library', 'Application Support', 'maws', 'script-favorites.json');

function readFavFile() {
  return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'));
}

afterEach(() => {
  if (fs.existsSync(FAV_FILE)) fs.unlinkSync(FAV_FILE);
});

afterAll(() => {
  os.homedir = ORIG_HOME;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ── script-runner:list ────────────────────────────────────────────────────────

describe('script-runner:list', () => {
  it('returns ok with prebaked, custom, and favorites arrays', async () => {
    const r = await list();
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.prebaked)).toBe(true);
    expect(Array.isArray(r.custom)).toBe(true);
    expect(Array.isArray(r.favorites)).toBe(true);
  });

  it('returns an empty favorites array when no favorites file exists', async () => {
    const r = await list();
    expect(r.favorites).toEqual([]);
  });

  it('returns stored favorites when the file exists', async () => {
    await toggleFavorite('enable-guardduty');
    const r = await list();
    expect(r.favorites).toContain('enable-guardduty');
  });

  it('prebaked list contains known scripts', async () => {
    const r = await list();
    const ids = r.prebaked.map(s => s.id);
    expect(ids).toContain('enable-guardduty');
    expect(ids).toContain('enable-cloudtrail');
  });
});

// ── script-runner:toggle-favorite ────────────────────────────────────────────

describe('script-runner:toggle-favorite', () => {
  it('adds an id to favorites on first toggle', async () => {
    const r = await toggleFavorite('enable-guardduty');
    expect(r.ok).toBe(true);
    expect(r.favorites).toContain('enable-guardduty');
  });

  it('persists the favorite to disk', async () => {
    await toggleFavorite('enable-guardduty');
    const saved = readFavFile();
    expect(saved).toContain('enable-guardduty');
  });

  it('removes an id that is already favorited (toggle off)', async () => {
    await toggleFavorite('enable-guardduty');
    const r = await toggleFavorite('enable-guardduty');
    expect(r.ok).toBe(true);
    expect(r.favorites).not.toContain('enable-guardduty');
  });

  it('removes the id from disk after toggling off', async () => {
    await toggleFavorite('enable-guardduty');
    await toggleFavorite('enable-guardduty');
    const saved = readFavFile();
    expect(saved).not.toContain('enable-guardduty');
  });

  it('can favorite multiple scripts independently', async () => {
    await toggleFavorite('enable-guardduty');
    await toggleFavorite('enable-cloudtrail');
    const r = await list();
    expect(r.favorites).toContain('enable-guardduty');
    expect(r.favorites).toContain('enable-cloudtrail');
  });

  it('removing one favorite leaves others intact', async () => {
    await toggleFavorite('enable-guardduty');
    await toggleFavorite('enable-cloudtrail');
    await toggleFavorite('enable-guardduty'); // remove
    const r = await list();
    expect(r.favorites).not.toContain('enable-guardduty');
    expect(r.favorites).toContain('enable-cloudtrail');
  });

  it('returns updated favorites list that matches what list() returns', async () => {
    await toggleFavorite('enable-guardduty');
    const toggleResult = await toggleFavorite('enable-cloudtrail');
    const listResult   = await list();
    expect(toggleResult.favorites.sort()).toEqual(listResult.favorites.sort());
  });

  it('handles toggling a custom (non-prebaked) id', async () => {
    const r = await toggleFavorite('custom-abc-123');
    expect(r.ok).toBe(true);
    expect(r.favorites).toContain('custom-abc-123');
  });
});
