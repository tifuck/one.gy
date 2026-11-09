// Browser stand-in for the app preload (window.onegy), backed by
// dev/mock-core.js. Lets src/ui run in a plain browser for UI work and
// screenshots: load mock-core.js, then this file, before src/ui/index.html.
// URL hash flags (comma separated): signed-out (setup flow), static (no live
// ticks), light (light theme), user=<name> (website user the panel opens for,
// default alice), screen=<syncs|transfers|issues|settings>, state=<site
// status state for the nav's Sync entry, default up_to_date>. The nav data
// (main/site-nav.js shape) is window.OnegyStubNav if set, else a sample.
(function () {
  'use strict';
  const flags = new Set(location.hash.slice(1).split(',').filter(Boolean));
  const opt = (name, dflt) => {
    const hit = [...flags].find((f) => f.startsWith(`${name}=`));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : dflt;
  };
  const engine = window.OnegyMock.createMockEngine({ signedIn: !flags.has('signed-out'), platform: 'linux' });
  const listeners = new Set();
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  const ok = (result) => Promise.resolve({ ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
  const fail = (err) => Promise.resolve({ ok: false, error: { code: err.code || 'internal', message: err.message, data: err.data || null } });
  let settings = {
    server_url: 'https://one.gy', launch_at_login: true, start_minimized: false, close_to_tray: true,
    theme: flags.has('light') ? 'frost' : 'frost-dark', site_zoom: 1, update_channel: 'stable', auto_update: true, prevent_sleep: true,
    notify: { conflict: true, issue: true, mass_delete: true, transfer: true, revoked: true, info: true },
  };
  const nav = window.OnegyStubNav || {
    links: [
      { label: 'Files', href: '/files', active: true, badge: 0 },
      { label: 'Notes', href: '/notes', active: false, badge: 2 },
      { label: 'Music', href: '/music', active: false, badge: 0 },
      { label: 'Prompts', href: '/prompts', active: false, badge: 0 },
    ],
    username: opt('user', 'alice'),
    role: 'User',
    account: { label: 'Account & settings', short: 'Account', href: '/account' },
    avatar: null,
  };
  const setSettings = (patch) => {
    settings = { ...settings, ...patch, notify: { ...settings.notify, ...(patch.notify || {}) } };
    emit({ type: 'app:settings', data: settings });
    return settings;
  };
  window.OnegyStubLog = [];
  engine.onEvent(emit);
  if (!flags.has('static')) setInterval(() => engine.tick(), 1000);
  // Like engine.subscribe: one status event right away; then the site's openSync().
  setTimeout(() => emit({ type: 'status', data: engine.overall() }), 50);
  setTimeout(() => emit({
    type: 'app:panel',
    data: {
      username: opt('user', 'alice'), screen: opt('screen', 'syncs'), theme: settings.theme, nav,
      status: { state: opt('state', 'up_to_date'), pending: 0, issues: 0 },
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
    // The site's theme option, as reported back by the site preload.
    siteTheme: (theme) => { window.OnegyStubLog.push(['siteTheme', theme]); return ok(setSettings({ theme }) && true); },
    siteLogout: () => { window.OnegyStubLog.push(['siteLogout']); return ok(true); },
    exportDiagnostics: () => ok(null),
    openDataFolder: () => ok(true),
    removeSync: (id) => {
      try { return ok(engine.call('syncs.remove', { id })); } catch (err) { return fail(err); }
    },
    pathForFile: () => '/srv/alice/Dropped',
  };
}());
