// Browser stand-in for the app preload (window.onegy), backed by
// dev/mock-core.js. Lets src/ui run in a plain browser for UI work and
// screenshots: load mock-core.js, then this file, before src/ui/index.html.
// URL hash flags (comma separated): signed-out (sign-in / setup flow), static
// (no live ticks), light (light theme), empty (no syncs yet), user=<name> (website user the panel
// opens for, default alice; user= for none, as when the app opens it),
// screen=<syncs|transfers|issues|settings>.
(function () {
  'use strict';
  const flags = new Set(location.hash.slice(1).split(',').filter(Boolean));
  const opt = (name, dflt) => {
    const hit = [...flags].find((f) => f.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : dflt;
  };
  const engine = window.OnegyMock.createMockEngine({ signedIn: !flags.has('signed-out'), empty: flags.has('empty'), platform: 'linux' });
  const listeners = new Set();
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  const ok = (result) => Promise.resolve({ ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
  const fail = (err) => Promise.resolve({ ok: false, error: { code: err.code || 'internal', message: err.message, data: err.data || null } });
  let settings = {
    server_url: 'https://one.gy', launch_at_login: true, start_minimized: false, close_to_tray: true,
    theme: flags.has('light') ? 'frost' : 'frost-dark', site_zoom: 1, update_channel: 'stable', auto_update: true, prevent_sleep: true,
    notify: { conflict: true, issue: true, mass_delete: true, transfer: true, revoked: true, info: true },
  };
  const setSettings = (patch) => {
    settings = { ...settings, ...patch, notify: { ...settings.notify, ...(patch.notify || {}) } };
    emit({ type: 'app:settings', data: settings });
    return settings;
  };
  // A check always finds 0.6.0; installing stays at installing.
  let update = {
    supported: true, kind: 'deb', state: 'idle', current: '0.2.0', version: null, progress: null, error: null, failed: null, checked_at: null,
  };
  const setUpdate = (patch) => {
    update = { ...update, ...patch };
    emit({ type: 'app:update', data: update });
    return ok(update);
  };
  window.OnegyStubLog = [];
  engine.onEvent(emit);
  if (!flags.has('static')) setInterval(() => engine.tick(), 1000);
  // Like engine.subscribe: one status event right away; then the site's openSync().
  setTimeout(() => emit({ type: 'status', data: engine.overall() }), 50);
  setTimeout(() => emit({
    type: 'app:panel',
    data: {
      username: opt('user', 'alice') || null, screen: opt('screen', 'syncs'), theme: settings.theme,
    },
  }), 100);

  window.onegy = {
    engine: (method, params) => {
      try { return ok(engine.call(method, params === undefined ? undefined : JSON.parse(JSON.stringify(params)))); } catch (err) { return fail(err); }
    },
    engineState: () => ok('connected'),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    version: () => ok({ app: '0.2.0', electron: '45.2.3', platform: 'linux', hostname: 'alice-laptop' }),
    appSettings: {
      get: () => ok(settings),
      set: (patch) => ok(setSettings(patch)),
    },
    probeServer: (url) => ok({ ok: true, origin: url, message: 'Server supports desktop sync.' }),
    pickFolder: () => ok('/srv/alice/Projects'),
    pickFiles: () => ok(['/srv/alice/Desktop/slides.pdf']),
    openPath: () => ok(true),
    openExternal: () => ok(true),
    openSite: (p) => { window.OnegyStubLog.push(['openSite', p]); return ok(true); },
    closePanel: () => ok(true),
    panelReady: () => ok(true),
    exportDiagnostics: () => ok(null),
    openDataFolder: () => ok(true),
    updateState: () => ok(update),
    checkForUpdates: () => setUpdate({ state: 'available', version: '0.6.0', checked_at: new Date().toISOString() }),
    installUpdate: () => { window.OnegyStubLog.push(['installUpdate']); return setUpdate({ state: 'installing' }); },
    removeSync: (id) => {
      try { return ok(engine.call('syncs.remove', { id })); } catch (err) { return fail(err); }
    },
    pathForFile: () => '/srv/alice/Dropped',
  };
}());
