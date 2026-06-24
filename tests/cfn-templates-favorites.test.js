'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Redirect HOME to a temp dir before requiring the feature module
const TEST_HOME  = fs.mkdtempSync(path.join(os.tmpdir(), 'maws-cfn-favs-test-'));
const ORIG_HOME  = os.homedir;
os.homedir = () => TEST_HOME;

// Mock keytar and ini — required transitively through aws-auth
jest.mock('keytar', () => ({
  getPassword: jest.fn(() => Promise.resolve(null)),
  setPassword: jest.fn(() => Promise.resolve()),
  deletePassword: jest.fn(() => Promise.resolve()),
}), { virtual: true });

jest.mock('ini', () => ({ parse: jest.fn(() => ({})) }), { virtual: true });

const feature  = require('../src/features/cfn-templates/index.js');
const handlers = feature.handlers;

const list           = ()   => handlers['cfn-templates:list']();
const toggleFavorite = (id) => handlers['cfn-templates:toggle-favorite'](null, { id });

const FAV_FILE = path.join(TEST_HOME, 'Library', 'Application Support', 'maws', 'cfn-favorites.json');

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

// ── cfn-templates:list ────────────────────────────────────────────────────────

describe('cfn-templates:list', () => {
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
    await toggleFavorite('production-vpc');
    const r = await list();
    expect(r.favorites).toContain('production-vpc');
  });

  it('prebaked list contains at least one template', async () => {
    const r = await list();
    expect(r.prebaked.length).toBeGreaterThan(0);
    expect(r.prebaked[0]).toHaveProperty('id');
    expect(r.prebaked[0]).toHaveProperty('name');
  });
});

// ── cfn-templates:toggle-favorite ────────────────────────────────────────────

describe('cfn-templates:toggle-favorite', () => {
  it('adds an id to favorites on first toggle', async () => {
    const r = await toggleFavorite('production-vpc');
    expect(r.ok).toBe(true);
    expect(r.favorites).toContain('production-vpc');
  });

  it('persists the favorite to disk', async () => {
    await toggleFavorite('production-vpc');
    const saved = readFavFile();
    expect(saved).toContain('production-vpc');
  });

  it('removes an id that is already favorited (toggle off)', async () => {
    await toggleFavorite('production-vpc');
    const r = await toggleFavorite('production-vpc');
    expect(r.ok).toBe(true);
    expect(r.favorites).not.toContain('production-vpc');
  });

  it('removes the id from disk after toggling off', async () => {
    await toggleFavorite('production-vpc');
    await toggleFavorite('production-vpc');
    const saved = readFavFile();
    expect(saved).not.toContain('production-vpc');
  });

  it('can favorite multiple templates independently', async () => {
    const firstId  = (await list()).prebaked[0]?.id || 'production-vpc';
    const secondId = (await list()).prebaked[1]?.id || 'custom-tmpl-2';
    await toggleFavorite(firstId);
    await toggleFavorite(secondId);
    const r = await list();
    expect(r.favorites).toContain(firstId);
    expect(r.favorites).toContain(secondId);
  });

  it('removing one favorite leaves others intact', async () => {
    await toggleFavorite('production-vpc');
    await toggleFavorite('custom-tmpl-xyz');
    await toggleFavorite('production-vpc'); // remove
    const r = await list();
    expect(r.favorites).not.toContain('production-vpc');
    expect(r.favorites).toContain('custom-tmpl-xyz');
  });

  it('returns updated favorites list consistent with list()', async () => {
    await toggleFavorite('production-vpc');
    const toggleResult = await toggleFavorite('custom-tmpl-xyz');
    const listResult   = await list();
    expect(toggleResult.favorites.sort()).toEqual(listResult.favorites.sort());
  });

  it('handles toggling a custom (non-prebaked) template id', async () => {
    const r = await toggleFavorite('custom-my-template-123');
    expect(r.ok).toBe(true);
    expect(r.favorites).toContain('custom-my-template-123');
  });
});
