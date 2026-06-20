'use strict';

/**
 * feature-registry.js
 *
 * Auto-loads every feature module found under src/features/.
 * Each feature is a directory containing an index.js that exports:
 *
 *   module.exports = {
 *     id:          'my-feature',          // unique, kebab-case
 *     name:        'My Feature',          // display name
 *     icon:        '🔍',                  // emoji or SVG string
 *     description: 'Does something cool', // one-liner shown in sidebar
 *     version:     '1.0.0',               // optional
 *
 *     // IPC handlers registered in the main process.
 *     // Key = channel name, value = async handler(event, ...args) => result
 *     handlers: {
 *       'my-feature:doThing': async (event, args) => { ... }
 *     },
 *   };
 *
 * The renderer accesses handlers via window.aws.invoke('my-feature:doThing', args).
 * Feature views live in src/renderer/features/<id>/view.js — see README for details.
 */

const fs = require('fs');
const path = require('path');

const FEATURES_DIR = path.join(__dirname, '../features');
const _features = [];

function loadAll(ipcMain) {
  if (!fs.existsSync(FEATURES_DIR)) return;

  const entries = fs.readdirSync(FEATURES_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(FEATURES_DIR, entry.name, 'index.js');
    if (!fs.existsSync(indexPath)) continue;

    try {
      const feature = require(indexPath);
      _features.push({
        id: feature.id,
        name: feature.name,
        icon: feature.icon || '🔧',
        description: feature.description || '',
        version: feature.version || '1.0.0',
      });

      // Register IPC handlers
      if (feature.handlers) {
        for (const [channel, handler] of Object.entries(feature.handlers)) {
          ipcMain.handle(channel, handler);
          console.log(`[features] registered IPC: ${channel}`);
        }
      }

      console.log(`[features] loaded: ${feature.name} (${feature.id})`);
    } catch (err) {
      console.error(`[features] failed to load ${entry.name}:`, err.message);
    }
  }
}

function list() {
  return _features;
}

module.exports = { loadAll, list };
