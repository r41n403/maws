'use strict';

// Minimal Electron mock so main-process modules can be required in Jest
module.exports = {
  app: {
    getPath: () => '/tmp/maws-test',
    getVersion: () => '0.0.0-test',
  },
  shell: {
    openExternal: jest.fn(),
  },
  ipcMain: {
    handle: jest.fn(),
  },
  systemPreferences: {
    canPromptTouchID: jest.fn(() => true),
    promptTouchID: jest.fn(() => Promise.resolve()),
  },
};
