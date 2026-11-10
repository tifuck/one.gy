// Bridge for the native sync panel (app://ui). Explicit functions only: no raw
// ipcRenderer, no arbitrary channels. Every call resolves to an envelope
// {ok, result} or {ok: false, error: {code, message, data}}.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Set();
ipcRenderer.on('onegy:event', (_e, event) => {
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error(err); }
  }
});

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('onegy', {
  engine: (method, params) => invoke('engine:call', method, params),
  engineState: () => invoke('engine:state'),
  onEvent: (fn) => {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  version: () => invoke('app:version'),
  appSettings: {
    get: () => invoke('app:settings:get'),
    set: (patch) => invoke('app:settings:set', patch),
  },
  probeServer: (url) => invoke('app:probeServer', url),
  pickFolder: (opts) => invoke('app:pickFolder', opts),
  pickFiles: () => invoke('app:pickFiles'),
  openPath: (p) => invoke('app:openPath', p),
  openExternal: (url) => invoke('app:openExternal', url),
  openSite: (pathname) => invoke('app:openSite', pathname),
  closePanel: () => invoke('app:closePanel'),
  // The panel has rendered what app:panel opened it with: show it now.
  panelReady: () => invoke('app:panelReady'),
  lockNow: () => invoke('app:lockNow'),
  exportDiagnostics: () => invoke('app:exportDiagnostics'),
  openDataFolder: () => invoke('app:openDataFolder'),
  // opts: { deleteLocal, releaseBackup }; deleteLocal moves the folder to the system trash.
  removeSync: (id, opts) => invoke('app:removeSync', id, opts),
  // Absolute path of a file or folder dropped onto the window.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
});
