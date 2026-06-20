'use strict';

/**
 * audit-logger.js
 *
 * Append-only JSONL audit log stored at:
 *   ~/Library/Application Support/maws/audit.log
 *
 * Each line is a self-contained JSON event. Format:
 * {
 *   id:        string (UUID v4),
 *   timestamp: ISO8601 string,
 *   category:  'auth' | 'feature' | 'console' | 'system',
 *   event:     string (SCREAMING_SNAKE_CASE),
 *   message:   string (human-readable),
 *   actor:     string | null  (identity ARN once authenticated),
 *   account:   string | null  (AWS account ID),
 *   profile:   string | null  (AWS profile name),
 *   result:    'success' | 'failure' | 'info',
 *   details:   object         (event-specific extra data),
 * }
 *
 * Future Jira integration: export entries as JSON and POST to
 * Jira's issue creation API with the entry mapped to fields.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

// Store in ~/Library/Application Support/maws/
const LOG_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'maws');
const LOG_FILE = path.join(LOG_DIR, 'audit.log');
const MAX_ENTRIES = 50_000; // rotate after this many entries

// Lazy init
let _initialized = false;

function init() {
  if (_initialized) return;
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  _initialized = true;
  log({
    category: 'system',
    event: 'APP_STARTED',
    message: 'Maws application started',
    result: 'info',
  });
}

/**
 * Write an audit event.
 * @param {object} opts
 * @param {'auth'|'feature'|'console'|'system'} opts.category
 * @param {string}  opts.event   - SCREAMING_SNAKE_CASE event name
 * @param {string}  opts.message - Human-readable description
 * @param {'success'|'failure'|'info'} opts.result
 * @param {string}  [opts.actor]   - Identity ARN
 * @param {string}  [opts.account] - AWS Account ID
 * @param {string}  [opts.profile] - AWS profile name
 * @param {object}  [opts.details] - Extra key/value data
 */
function log(opts) {
  if (!_initialized) init();

  const entry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    category: opts.category,
    event: opts.event,
    message: opts.message,
    actor: opts.actor || null,
    account: opts.account || null,
    profile: opts.profile || null,
    result: opts.result || 'info',
    details: opts.details || {},
  };

  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.error('[audit] failed to write log entry:', err.message);
  }

  return entry;
}

/**
 * Read and parse all entries from the log file.
 * Returns entries sorted newest-first by default.
 * Supports optional filtering.
 *
 * @param {object} [filter]
 * @param {string} [filter.category]
 * @param {string} [filter.result]   'success' | 'failure' | 'info'
 * @param {string} [filter.search]   Searches message, event, actor, account
 * @param {number} [filter.limit]    Max entries to return (default 500)
 * @param {string} [filter.since]    ISO timestamp — only entries after this
 */
function getEntries(filter = {}) {
  if (!fs.existsSync(LOG_FILE)) return [];

  const raw = fs.readFileSync(LOG_FILE, 'utf-8');
  let entries = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean);

  // Apply filters
  if (filter.category) {
    entries = entries.filter((e) => e.category === filter.category);
  }
  if (filter.result) {
    entries = entries.filter((e) => e.result === filter.result);
  }
  if (filter.since) {
    const since = new Date(filter.since).getTime();
    entries = entries.filter((e) => new Date(e.timestamp).getTime() >= since);
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    entries = entries.filter((e) =>
      (e.message || '').toLowerCase().includes(q) ||
      (e.event || '').toLowerCase().includes(q) ||
      (e.actor || '').toLowerCase().includes(q) ||
      (e.account || '').toLowerCase().includes(q) ||
      (e.profile || '').toLowerCase().includes(q)
    );
  }

  // Newest first
  entries.reverse();

  const limit = filter.limit || 500;
  return entries.slice(0, limit);
}

/**
 * Export all entries as a JSON string (for Jira/external integrations).
 */
function exportJSON() {
  return JSON.stringify(getEntries({ limit: MAX_ENTRIES }), null, 2);
}

/**
 * Export all entries as CSV.
 */
function exportCSV() {
  const entries = getEntries({ limit: MAX_ENTRIES });
  const headers = ['id', 'timestamp', 'category', 'event', 'message', 'actor', 'account', 'profile', 'result'];
  const rows = entries.map((e) =>
    headers.map((h) => JSON.stringify(e[h] ?? '')).join(',')
  );
  return [headers.join(','), ...rows].join('\n');
}

/**
 * Returns log file path and entry count for info display.
 */
function getInfo() {
  if (!fs.existsSync(LOG_FILE)) return { path: LOG_FILE, count: 0, sizeKB: 0 };
  const stat = fs.statSync(LOG_FILE);
  const count = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean).length;
  return {
    path: LOG_FILE,
    count,
    sizeKB: Math.round(stat.size / 1024),
  };
}

// Init on module load
init();

module.exports = { log, getEntries, exportJSON, exportCSV, getInfo };
