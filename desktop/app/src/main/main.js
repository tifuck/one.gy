// App lifecycle: single instance, engine supervision, window, tray, autostart,
// close-to-tray, power-save blocker while syncing, updates and quit.
'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog, Menu, Notification, powerMonitor, powerSaveBlocker, session, shell } = require('electron');
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
  const state = {
    quitting: false,
    engineStopped: false,
    status: null,
    syncs: new Map(),
    recent: [],
    pauseTimer: null,
    pausedUntil: null,
    blocker: null,
  };
  let window = null;
  let tray = null;

  const showNotification = ({ title, body, kind }) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: kind === 'transfer' });
    const screen = { conflict: 'issues', issue: 'issues', mass_delete: 'issues', transfer: 'transfers', revoked: 'settings' }[kind];
    n.on('click', () => (screen ? window.navigate(screen) : window.show()));
    n.show();
  };
  const notify = createNotifier({ show: showNotification, isEnabled: (kind) => settings.get().notify[kind] !== false });

  const updatePowerSave = () => {
    const busy = Boolean(state.status && state.status.state === 'syncing') && settings.get().prevent_sleep;
    if (busy && state.blocker === null) state.blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && state.blocker !== null) {
      powerSaveBlocker.stop(state.blocker);
      state.blocker = null;
    }
  };

  const refreshCaches = async () => {
    try {
      const syncs = await engine.call('syncs.list');
      state.syncs = new Map((syncs || []).map((s) => [s.id, s]));
      state.recent = (await engine.call('activity.recent', { limit: 5 })) || [];
      tray.update({ recent: state.recent });
    } catch (err) {
      console.error(`[APP] could not load syncs: ${err.message}`);
    }
  };

  engine.on('state', (s) => {
    window.send({ type: 'app:engine', data: { state: s } });
    tray.update({ engineState: s });
    if (s === 'connected') refreshCaches();
  });
  engine.on('event', (ev) => {
    window.send(ev);
    switch (ev.type) {
      case 'status':
        state.status = ev.data;
        tray.update({ status: ev.data });
        updatePowerSave();
        break;
      case 'sync':
        if (ev.data && ev.data.id) state.syncs.set(ev.data.id, ev.data);
        break;
      case 'activity':
        state.recent = [ev.data, ...state.recent].slice(0, 5);
        tray.update({ recent: state.recent });
        break;
      case 'notify':
        notify(ev.data);
        break;
      default:
    }
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

  // Reveal a recent change: only paths that stay inside the sync root.
  const reveal = (item) => {
    const sync = item && state.syncs.get(item.sync_id);
    if (!sync || typeof item.path !== 'string') return window.navigate('sync');
    const root = path.resolve(sync.local_path);
    const target = path.resolve(root, ...item.path.split('/'));
    if (target !== root && !target.startsWith(root + path.sep)) return window.navigate('sync');
    shell.showItemInFolder(target);
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

    registerIpc({ window, engine, settings });
    watchEnvironment({ powerMonitor, engine });

    tray = new AppTray({
      open: () => window.show(),
      navigate: (screen) => window.navigate(screen),
      pauseAll,
      resumeAll,
      upload: async () => {
        const res = await dialog.showOpenDialog({ title: 'Upload to one.gy', properties: ['openFile', 'multiSelections', 'dontAddToRecent'] });
        if (res.canceled || !res.filePaths.length) return;
        window.navigate('transfers');
        window.send({ type: 'app:action', data: { action: 'upload', paths: res.filePaths } });
      },
      download: () => {
        window.navigate('transfers');
        window.send({ type: 'app:action', data: { action: 'download' } });
      },
      reveal,
      quit,
    });

    settings.onChange((next, before) => {
      if (next.server_url !== before.server_url) window.recreateSite();
      if (next.theme !== before.theme) window.setTheme(next.theme);
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
