'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Exposes a clean, typed API to the renderer via window.aws.
 * Only the methods listed here are accessible — no raw IPC exposed.
 */
contextBridge.exposeInMainWorld('aws', {
  // Auth
  listProfiles: () => ipcRenderer.invoke('auth:list-profiles'),
  loginSSO: (profile) => ipcRenderer.invoke('auth:login-sso', profile),
  loginProfile: (profile) => ipcRenderer.invoke('auth:login-profile', profile),
  getIdentity: () => ipcRenderer.invoke('auth:get-identity'),
  getSession: () => ipcRenderer.invoke('auth:get-session'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Features
  listFeatures: () => ipcRenderer.invoke('features:list'),

  // Generic IPC invoke — for feature modules to call their own handlers.
  // Channel must start with a known prefix to prevent renderer XSS from
  // calling arbitrary main-process handlers.
  invoke: (channel, ...args) => {
    const allowed = [
      'auth:', 'features:', 'health:', 'audit:', 'shell:',
      'billing:', 'util:', 'settings:', 'lock:',
      'arn-scratchpad:', 'resource-lister:', 'route53:',
    ];
    if (!allowed.some(p => channel.startsWith(p)))
      throw new Error(`Blocked IPC channel: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },

  // Health
  healthGetStatus: () => ipcRenderer.invoke('health:get-status'),

  // Audit log
  auditGetEntries: (filter) => ipcRenderer.invoke('audit:get-entries', filter),
  auditLog: (opts) => ipcRenderer.invoke('audit:log', opts),
  auditExportJSON: () => ipcRenderer.invoke('audit:export-json'),
  auditExportCSV: () => ipcRenderer.invoke('audit:export-csv'),
  auditGetInfo: () => ipcRenderer.invoke('audit:get-info'),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
});
