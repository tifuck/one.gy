// Browser stand-in for the app preload (window.onegy), backed by
// dev/mock-core.js. Lets src/ui run in a plain browser for UI work and
// screenshots: load mock-core.js, then this file, before src/ui/index.html.
// URL hash flags: #signed-out (start in the wizard), #static (no live ticks),
// #light (light theme).
(function () {
  'use strict';
  const flags = new Set(location.hash.slice(1).split(',').filter(Boolean));
  const engine = window.OnegyMock.createMockEngine({ signedIn: !flags.has('signed-out'), platform: 'linux' });
  const listeners = new Set();
  const ok = (result) => Promise.resolve({ ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
  const fail = (err) => Promise.resolve({ ok: false, error: { code: err.code || 'internal', message: err.message, data: err.data || null } });
  let settings = {
    server_url: 'https://one.gy', launch_at_login: true, start_minimized: false, close_to_tray: true,
    theme: flags.has('light') ? 'frost' : 'frost-dark', update_channel: 'stable', auto_update: true, prevent_sleep: true,
    notify: { conflict: true, issue: true, mass_delete: true, transfer: true, revoked: true, info: true },
  };
  engine.onEvent((ev) => listeners.forEach((fn) => fn(ev)));
  if (!flags.has('static')) setInterval(() => engine.tick(), 1000);
  // Like engine.subscribe: one status event right away.
  setTimeout(() => listeners.forEach((fn) => fn({ type: 'status', data: engine.overall() })), 50);

  window.onegy = {
    engine: (method, params) => {
      try { return ok(engine.call(method, params === undefined ? undefined : JSON.parse(JSON.stringify(params)))); } catch (err) { return fail(err); }
    },
    engineState: () => ok('connected'),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    version: () => ok({ app: '0.1.0', electron: '45.2.3', platform: 'linux', hostname: 'alice-laptop' }),
    appSettings: {
      get: () => ok(settings),
      set: (patch) => {
        settings = { ...settings, ...patch, notify: { ...settings.notify, ...(patch.notify || {}) } };
        listeners.forEach((fn) => fn({ type: 'app:settings', data: settings }));
        return ok(settings);
      },
    },
    probeServer: (url) => ok({ ok: true, origin: url, message: 'Server supports desktop sync.' }),
    pickFolder: () => ok('/srv/alice/Projects'),
    pickFiles: () => ok(['/srv/alice/Desktop/slides.pdf']),
    openPath: () => ok(true),
    openExternal: () => ok(true),
    openSite: () => ok(true),
    view: () => ok(true),
    siteBounds: () => ok(true),
    siteNav: () => ok(true),
    exportDiagnostics: () => ok(null),
    openDataFolder: () => ok(true),
    removeSync: (id) => {
      try { return ok(engine.call('syncs.remove', { id })); } catch (err) { return fail(err); }
    },
    pathForFile: () => '/srv/alice/Dropped',
  };
}());
