// App lifecycle: single instance, engine supervision, window, tray, autostart,
// close-to-tray, power-save blocker while syncing, the website bridge status
// push, updates and quit.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog, Menu, Notification, powerMonitor, powerSaveBlocker, session } = require('electron');
const { registerScheme, handleScheme } = require('./protocol');
const { hardenApp } = require('./security');
const { SettingsStore } = require('./settings-store');
const { EngineSupervisor } = require('./engine');
const { MainWindow } = require('./window');
const { registerIpc } = require('./ipc');
const { AppTray } = require('./tray');
const { createNotifier } = require('./notify');
const { startUpdater } = require('./updater');
const { watchEnvironment } = require('./environment');
const { SyncStatus, throttle } = require('./sync-status');

const SITE_STATUS_EVERY_MS = 500; // site-bridge.md: at most 2 updates per second

const APP_ID = 'gy.one.desktop';
const ENGINE_EXE = process.platform === 'win32' ? 'onegy-engine.exe' : 'onegy-engine';
const DEV = !app.isPackaged;
const argValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

registerScheme();
hardenApp();
app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function engineCommand() {
  if (DEV && process.argv.includes('--mock-engine')) {
    return {
      command: process.execPath,
      args: [path.join(__dirname, '..', '..', 'dev', 'mock-engine.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  // Dev runs use what `npm run build:engine` writes (the same place the installer build copies from).
  const dir = DEV ? path.join(__dirname, '..', '..', 'resources', 'engine') : path.join(process.resourcesPath, 'engine');
  return { command: path.join(dir, ENGINE_EXE), args: [], env: {} };
}

// Windows: Run key via Electron. Linux: XDG autostart entry. Dev runs skip it.
function applyAutostart(enabled) {
  if (DEV) return;
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    return;
  }
  if (process.platform !== 'linux') return;
  const file = path.join(app.getPath('appData'), 'autostart', `${APP_ID}.desktop`);
  try {
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    const exe = process.env.APPIMAGE || process.execPath;
    const quoted = `"${exe.replace(/[\\"`$]/g, '\\$&')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=ONE.GY Desktop',
      `Exec=${quoted} --hidden`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  } catch (err) {
    console.error(`[APP] autostart update failed: ${err.message}`);
  }
}

function start() {
  const settings = new SettingsStore(app.getPath('userData'));
  const devServer = DEV ? argValue('server') : null;
  if (devServer) settings.set({ server_url: devServer });

  const engine = new EngineSupervisor(engineCommand());
  const sync = new SyncStatus(engine);
  const state = {
    quitting: false,
    engineStopped: false,
    pauseTimer: null,
    pausedUntil: null,
    blocker: null,
  };
  let window = null;
  let tray = null;

  // The sync panel for the account of the site page (else this computer's).
  // From the tray, the keyboard and notifications only once this computer is
  // authorized; the website's Sync entry also reaches the setup (ipc.js).
  const openPanel = (screen) => {
    if (!sync.authorized()) return window.show();
    return window.openPanel({ username: window.siteUser || sync.account.username, screen });
  };

  const showNotification = ({ title, body, kind }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: kind === 'transfer' });
    const screen = { conflict: 'issues', issue: 'issues', mass_delete: 'issues', transfer: 'transfers', revoked: 'settings' }[kind];
    n.on('click', () => (screen ? openPanel(screen) : window.show()));
    n.show();
  };
  const notify = createNotifier({ show: showNotification, isEnabled: (kind) => settings.get().notify[kind] !== false });

  const updatePowerSave = () => {
    const busy = Boolean(sync.status && sync.status.state === 'syncing') && settings.get().prevent_sleep;
    if (busy && state.blocker === null) state.blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && state.blocker !== null) {
      powerSaveBlocker.stop(state.blocker);
      state.blocker = null;
    }
  };

  // Website onStatus subscribers: throttled, and only when something changed.
  let lastSiteStatus = '';
  const pushSiteStatus = throttle(() => {
    const st = sync.forUser(window.siteUser);
    const key = JSON.stringify([window.siteUser, st]);
    if (key === lastSiteStatus) return;
    lastSiteStatus = key;
    window.sendSiteStatus(st);
  }, SITE_STATUS_EVERY_MS);

  sync.on('change', () => {
    tray.update({ authorized: sync.authorized(), status: sync.status, engineState: sync.engineState });
    updatePowerSave();
    pushSiteStatus();
  });
  engine.on('state', (s) => window.send({ type: 'app:engine', data: { state: s } }));
  engine.on('event', (ev) => {
    window.send(ev);
    if (ev.type === 'notify') notify(ev.data);
  });

  const pauseAll = async (ms) => {
    clearTimeout(state.pauseTimer);
    state.pausedUntil = ms ? Date.now() + ms : null;
    await engine.call('syncs.pause', {}).catch((err) => console.error(`[APP] pause failed: ${err.message}`));
    if (ms) state.pauseTimer = setTimeout(() => resumeAll(), ms);
    tray.update({ pausedUntil: state.pausedUntil });
  };
  const resumeAll = async () => {
    clearTimeout(state.pauseTimer);
    state.pausedUntil = null;
    await engine.call('syncs.resume', {}).catch((err) => console.error(`[APP] resume failed: ${err.message}`));
    tray.update({ pausedUntil: null });
  };

  const quit = () => app.quit();

  app.on('second-instance', () => window && window.show());
  app.on('window-all-closed', () => { /* tray keeps the app alive */ });
  app.on('before-quit', (e) => {
    state.quitting = true;
    if (state.engineStopped) return;
    e.preventDefault();
    engine.stop().finally(() => {
      state.engineStopped = true;
      app.quit();
    });
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    handleScheme(session.defaultSession);

    window = new MainWindow({
      settings,
      serverOrigin: () => settings.get().server_url,
      onSiteMutation: () => engine.call('engine.nudge').catch(() => {}),
      onSyncShortcut: () => { if (sync.authorized()) openPanel('syncs'); },
    });
    const startHidden = process.argv.includes('--hidden') || settings.get().start_minimized;
    const win = window.create({ show: !startHidden });
    win.on('close', (e) => {
      if (state.quitting) return;
      if (settings.get().close_to_tray) {
        e.preventDefault();
        win.hide();
      } else {
        app.quit();
      }
    });

    registerIpc({ window, engine, settings, sync });
    watchEnvironment({ powerMonitor, engine });

    tray = new AppTray({
      open: () => window.show(),
      openSync: () => openPanel('syncs'),
      pauseAll,
      resumeAll,
      upload: async () => {
        if (!sync.authorized()) return;
        const res = await dialog.showOpenDialog({ title: 'Upload to one.gy', properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
        if (res.canceled || !res.filePaths.length) return;
        openPanel('transfers');
        window.send({ type: 'app:action', data: { action: 'upload', paths: res.filePaths } });
      },
      quit,
    });

    settings.onChange((next, before) => {
      if (next.server_url !== before.server_url) window.recreateSite();
      if (next.theme !== before.theme) window.setTheme();
      if (next.launch_at_login !== before.launch_at_login) applyAutostart(next.launch_at_login);
      if (next.prevent_sleep !== before.prevent_sleep) updatePowerSave();
      window.send({ type: 'app:settings', data: next });
    });
    applyAutostart(settings.get().launch_at_login);

    startUpdater({
      settings,
      notify: ({ title, body }) => showNotification({ title, body, kind: 'info' }),
      parentWindow: () => window.win,
      beforeInstall: async () => {
        state.quitting = true;
        await engine.stop();
        state.engineStopped = true;
      },
    });

    engine.start();
  });
}
