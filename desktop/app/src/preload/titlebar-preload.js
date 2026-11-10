// Bridge for the title bar view (app://ui/titlebar.html): state in, history
// commands and its colours out. The main process checks the sender.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onegyTitlebar', Object.freeze({
  onState: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('onegy:titlebar', (_e, state) => cb(state));
  },
  command: (name) => ipcRenderer.send('titlebar:command', name),
  colors: (c) => ipcRenderer.send('titlebar:colors', c),
}));
