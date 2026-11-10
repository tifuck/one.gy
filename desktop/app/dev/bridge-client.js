// window.onegy for a browser page served by dev/browser-bridge.js: the same
// functions as src/preload/app-preload.js, carried over fetch + EventSource.
// Load it before the UI (Playwright add_init_script).
(function () {
  'use strict';
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch((err) => ({ ok: false, error: { code: 'bridge', message: err.message } }));
  const app = (name) => (...args) => post(`/app/${name}`, { args });
  const listeners = new Set();
  const events = new EventSource('/events');
  events.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    for (const fn of listeners) {
      try { fn(ev); } catch (err) { console.error(err); }
    }
  };
  window.onegy = {
    engine: (method, params) => post('/rpc', { method, params }),
    engineState: app('engineState'),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    version: app('version'),
    appSettings: { get: app('appSettings.get'), set: app('appSettings.set') },
    probeServer: app('probeServer'),
    pickFolder: app('pickFolder'),
    pickFiles: app('pickFiles'),
    openPath: app('openPath'),
    openExternal: app('openExternal'),
    openSite: app('openSite'),
    closePanel: app('closePanel'),
    panelReady: app('panelReady'),
    exportDiagnostics: app('exportDiagnostics'),
    openDataFolder: app('openDataFolder'),
    removeSync: app('removeSync'),
    pathForFile: () => null,
  };
}());
