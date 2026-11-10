// Bridge for the update toast view (app://ui/update.html): updater state in,
// its action and card height out. The main process checks the sender.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onegyUpdate', Object.freeze({
  onState: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('onegy:update', (_e, state) => cb(state));
  },
  // Update and restart / Restart now / Try again.
  install: () => ipcRenderer.send('update:install'),
  size: (px) => ipcRenderer.send('update:size', px),
}));
