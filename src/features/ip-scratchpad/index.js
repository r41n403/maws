'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
function genId() {
  try { return require('crypto').randomUUID(); } catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
}

const DATA_DIR  = path.join(os.homedir(), 'Library', 'Application Support', 'maws');
const DATA_FILE = path.join(DATA_DIR, 'ips.json');

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

function isValidIP(ip) {
  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(ip)) {
    const parts = ip.split('/')[0].split('.');
    return parts.every(p => parseInt(p, 10) <= 255);
  }
  // IPv6 (basic check)
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':')) return true;
  return false;
}

module.exports = {
  id:          'ip-scratchpad',
  name:        'IP Scratchpad',
  icon:        '🌐',
  description: 'Save and quickly copy IP addresses for resources you use frequently.',

  handlers: {
    'ip-scratchpad:list': async () => {
      return { ok: true, entries: load() };
    },

    'ip-scratchpad:add': async (_e, { ip, label }) => {
      if (!ip || !isValidIP(ip.trim())) return { ok: false, error: 'Not a valid IP address (IPv4, IPv6, or CIDR)' };
      const entries = load();
      const entry = { id: genId(), ip: ip.trim(), label: (label || '').trim(), addedAt: new Date().toISOString() };
      entries.unshift(entry);
      save(entries);
      return { ok: true, entry };
    },

    'ip-scratchpad:delete': async (_e, { id }) => {
      const entries = load().filter(e => e.id !== id);
      save(entries);
      return { ok: true };
    },

    'ip-scratchpad:update-label': async (_e, { id, label }) => {
      const entries = load();
      const entry = entries.find(e => e.id === id);
      if (entry) { entry.label = (label || '').trim(); save(entries); }
      return { ok: true };
    },
  },
};
