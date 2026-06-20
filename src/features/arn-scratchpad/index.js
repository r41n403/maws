'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
function genId() {
  try { return require('crypto').randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
}

const DATA_DIR  = path.join(os.homedir(), 'Library', 'Application Support', 'maws');
const DATA_FILE = path.join(DATA_DIR, 'arns.json');

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return [];
}

function save(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

module.exports = {
  id:          'arn-scratchpad',
  name:        'ARN Scratchpad',
  icon:        '📌',
  description: 'Save and quickly copy ARNs for resources you use frequently.',

  handlers: {
    'arn-scratchpad:list': async () => {
      return { ok: true, entries: load() };
    },

    'arn-scratchpad:add': async (_e, { arn, label }) => {
      if (!arn || !arn.startsWith('arn:')) return { ok: false, error: 'Not a valid ARN (must start with "arn:")' };
      const entries = load();
      const entry = { id: genId(), arn: arn.trim(), label: (label || '').trim(), addedAt: new Date().toISOString() };
      entries.unshift(entry);
      save(entries);
      return { ok: true, entry };
    },

    'arn-scratchpad:delete': async (_e, { id }) => {
      const entries = load().filter(e => e.id !== id);
      save(entries);
      return { ok: true };
    },

    'arn-scratchpad:update-label': async (_e, { id, label }) => {
      const entries = load();
      const entry = entries.find(e => e.id === id);
      if (entry) { entry.label = (label || '').trim(); save(entries); }
      return { ok: true };
    },
  },
};
