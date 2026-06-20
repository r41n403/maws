'use strict';

/**
 * health-checker.js
 *
 * Polls AWS Service Health Dashboard every 10 minutes.
 * Tries two endpoints in order:
 *   1. https://status.aws.amazon.com/data.json  (legacy JSON API)
 *   2. https://status.aws.amazon.com/rss/all.rss (RSS feed, XML parse)
 *
 * Status levels:
 *   green  — no active events
 *   yellow — informational / performance degradation
 *   red    — service disruption or outage
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEBUG_DIR = path.join(os.homedir(), 'Documents', 'maws');
const DEBUG_FILE = path.join(DEBUG_DIR, 'health-debug.log');

function debugLog(label, content) {
  const entry = `\n${'='.repeat(60)}\n[${new Date().toISOString()}] ${label}\n${'='.repeat(60)}\n${content}\n`;
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.appendFileSync(DEBUG_FILE, entry, 'utf-8');
}

const POLL_INTERVAL_MS = 10 * 60 * 1000;
const JSON_URL = 'https://status.aws.amazon.com/data.json';
const RSS_URL  = 'https://status.aws.amazon.com/rss/all.rss';

let _cache = {
  status: 'unknown',
  events: [],
  lastChecked: null,
  error: null,
  source: null,
};

let _timer = null;

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function fetchBuffer(url, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 3) return reject(new Error('Too many redirects'));
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchBuffer(res.headers.location, _redirects + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function bufferToString(buf) {
  // Detect UTF-16 BOM and decode accordingly
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le'); // UTF-16 LE
  if (buf[0] === 0xFE && buf[1] === 0xFF) return buf.swap16().slice(2).toString('utf16le'); // UTF-16 BE
  // Strip UTF-8 BOM if present
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  return buf.toString('utf8');
}

function fetchRaw(url) {
  return fetchBuffer(url).then(bufferToString);
}

// ── JSON strategy ─────────────────────────────────────────────────────────────

// AWS JSON status codes: 0=normal, 1=info, 2=perf issue, 3=disruption, 4=outage
function classifyStatusCode(code) {
  const n = parseInt(code, 10);
  if (n === 0) return 'green';
  if (n <= 2)  return 'yellow';
  return 'red';
}

function classifyText(str = '') {
  const s = str.toLowerCase();
  if (s.includes('disruption') || s.includes('outage') || s.includes('unavailable')) return 'red';
  if (s.includes('impact') || s.includes('degradation') || s.includes('degraded') ||
      s.includes('increased error') || s.includes('connectivity')) return 'yellow';
  return 'yellow';
}

async function tryJSON() {
  const raw = await fetchRaw(JSON_URL);
  debugLog('JSON decoded (first 2000 chars)', raw.slice(0, 2000));
  if (raw.trimStart().startsWith('<')) throw new Error('JSON endpoint returned HTML');
  const data = JSON.parse(raw.trimStart());

  // API may return array directly or wrapped in { current: [] }
  const current = Array.isArray(data) ? data : (data.current || []);
  if (!current.length) return { status: 'green', events: [], source: 'json' };

  const events = current.map((e) => ({
    service: e.service_name || e.service || 'Unknown',
    region: e.region_name || '',
    summary: e.summary || '',
    statusCode: e.status,
    level: classifyStatusCode(e.status),
  }));

  const status = events.some((e) => e.level === 'red') ? 'red'
               : events.some((e) => e.level === 'yellow') ? 'yellow'
               : 'green';
  return { status, events, source: 'json' };
}

// ── RSS strategy ──────────────────────────────────────────────────────────────

async function tryRSS() {
  const raw = await fetchRaw(RSS_URL);
  debugLog('RSS raw response (first 3000 chars)', raw.slice(0, 3000));
  if (!raw.includes('<rss') && !raw.includes('<feed')) throw new Error('RSS response is not XML');

  // Extract <item> blocks — no external XML parser needed
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(raw)) !== null) {
    const block = match[1];
    const rawTitle = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(block) || [])[1] || '';
    const title = rawTitle.replace(/<!\[CDATA\[|\]\]>/g, '').trim();

    // Extract service/region from guid hash: #multipleservices-me-central-1_timestamp
    const guidRaw = (/<guid[^>]*>([\s\S]*?)<\/guid>/i.exec(block) || [])[1] || '';
    const hashMatch = /#([^_]+)_/.exec(guidRaw);
    const service = hashMatch
      ? hashMatch[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      : 'AWS';

    const pubDate = (/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block) || [])[1] || '';

    items.push({ title, service, pubDate });
  }

  debugLog('RSS parsed items (all)', JSON.stringify(items, null, 2));

  // Filter out resolved/normal entries — only keep active incidents
  const activeItems = items.filter((i) => {
    const t = i.title.toLowerCase();
    return !t.includes('[resolved]') &&
           !t.includes('operating normally') &&
           !t.includes('service is operating') &&
           !t.includes('has been resolved') &&
           !t.includes('resolved at');
  });

  if (!activeItems.length) return { status: 'green', events: [], source: 'rss' };

  const events = activeItems.slice(0, 20).map((i) => ({
    service: i.service,
    summary: i.title,
    status: i.title,
    level: classifyEvent(i.title),
  }));

  const status = events.some((e) => e.level === 'red') ? 'red' : 'yellow';
  return { status, events, source: 'rss' };
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function poll() {
  let result;
  try {
    result = await tryJSON();
    console.log(`[health] ✓ JSON — status: ${result.status} (${result.events.length} events)`);
  } catch (jsonErr) {
    console.warn(`[health] JSON failed (${jsonErr.message}), trying RSS…`);
    try {
      result = await tryRSS();
      console.log(`[health] ✓ RSS  — status: ${result.status} (${result.events.length} events)`);
    } catch (rssErr) {
      console.error(`[health] RSS also failed: ${rssErr.message}`);
      _cache = { ..._cache, status: 'unknown', error: rssErr.message, lastChecked: new Date().toISOString() };
      return;
    }
  }

  _cache = {
    status: result.status,
    events: result.events,
    lastChecked: new Date().toISOString(),
    error: null,
    source: result.source,
  };
}

function startPolling() {
  poll();
  _timer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (_timer) clearInterval(_timer);
}

function getStatus() {
  return { ..._cache };
}

module.exports = { startPolling, stopPolling, getStatus };
