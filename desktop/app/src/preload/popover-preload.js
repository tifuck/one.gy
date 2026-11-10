// Bridge for the tray popover (app://ui/popover.html): a few read-only engine
// methods (the same envelopes as app-preload's engine) and engine events in,
// the tray's actions out. The main process checks the sender and the names.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('onegy:event', (_e, event) => {
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error(err); }
  }
});

contextBridge.exposeInMainWorld('onegy', Object.freeze({
  engine: (method, params) => ipcRenderer.invoke('popover:engine', method, params),
  onEvent: (fn) => {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
}));

contextBridge.exposeInMainWorld('onegyTray', Object.freeze({
  // { theme, platform, engine, status, pausedUntil } each time it opens.
  onShow: (cb) => {
    if (typeof cb === 'function') ipcRenderer.on('onegy:popover', (_e, state) => cb(state));
  },
  // open, panel(screen), folder(sync id), pause(ms|null), resume, upload, close
  action: (name, arg) => ipcRenderer.send('popover:action', name, arg),
}));
