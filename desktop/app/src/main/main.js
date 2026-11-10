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
const { SyncStatus, appLocked, throttle } = require('./sync-status');
const { isSitePath } = require('./site-nav');

const SITE_STATUS_EVERY_MS = 500; // site-bridge.md: at most 2 updates per second
const IDLE_CHECK_MS = 30 * 1000;
const SITE_DECIDE_MAX_MS = 8000; // load the site anyway when the engine says nothing
const UPDATE_IDLE_S = 300; // an update restarts a visible window only after this much user idle time
const RESIGN_EVERY_MS = 30 * 1000; // device mode: sign a site view that lost its session in again, at most this often

const APP_ID = 'gy.one.desktop';
const ENGINE_EXE = process.platform === 'win32' ? 'onegy-engine.exe' : 'onegy-engine';
const DEV = !app.isPackaged;
const parseUrl = (u) => {
  try { return new URL(u); } catch { return null; }
};
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
      'Name=ONE.GY',
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
  // Written before an update restart so a window hidden in the tray stays hidden.
  const hiddenMarker = path.join(app.getPath('userData'), 'relaunch-hidden');
  const relaunchHidden = fs.existsSync(hiddenMarker);
  fs.rmSync(hiddenMarker, { force: true });
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
  let updater = null;

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

  // ---- Site modes and the app lock (engine-ipc.md "App lock") ----
  // locked: no site page, the lock screen (PIN or password) over an empty view.
  // device: this computer is signed in and unlocked: the site is signed in with
  // a one-use device ticket, so the website never asks for the password.
  // plain: not signed in (or no engine): the app's sign-in screen over the
  // site's own sign-in page, which only shows if there is no engine to sign in with.
  let siteMode = null;
  let signingOut = false;
  let lastResign = 0;
  const siteModeFor = () => {
    if (appLocked(sync.account)) return 'locked';
    if (sync.account && sync.account.signed_in && !sync.account.app_locked) return 'device';
    if (sync.account || sync.engineState === 'missing') return 'plain';
    return null;
  };
  const applySiteMode = async (force) => {
    const want = force || siteModeFor();
    if (!want || want === siteMode) return;
    // Signing in, the engine reports the app locked until its first unlock
    // grant arrives (account.Status: no grant yet): part of the sign-in, not a
    // lock. A lock that stays shows in the panel; the site has no session yet.
    if (want === 'locked' && siteMode === 'plain') return;
    const wasLocked = siteMode === 'locked';
    console.log(`[APP] site mode ${siteMode} -> ${want}`);
    siteMode = want;
    if (want === 'locked') {
      await window.lockSite();
      window.openPanel({ username: sync.account.username, screen: 'lock' });
      return;
    }
    if (want === 'device') {
      try {
        window.unlockSite(await engine.call('account.webSession'));
        if (wasLocked) window.closePanel(); // else the setup wizard goes on
        return;
      } catch (err) {
        console.error(`[APP] website sign-in with the device failed: ${err.message}`);
      }
    }
    window.siteLocked = false;
    window.recreateSite(true);
    if (wasLocked) window.closePanel();
    // Signed out: sign in once here; the site then follows (device mode).
    if (sync.account && !sync.account.signed_in) window.openPanel({ username: null, screen: 'signin' });
  };
  // Device mode and the site lands on its sign-in page (session expired or
  // ended elsewhere): sign it in again with a fresh device ticket and go on
  // to the page that was asked for.
  const onSiteNavigate = (url, wanted) => {
    const at = parseUrl(url);
    if (!at || at.pathname !== '/login' || siteMode !== 'device' || signingOut || Date.now() - lastResign < RESIGN_EVERY_MS) return;
    lastResign = Date.now();
    const w = parseUrl(wanted);
    const next = w && w.origin === settings.get().server_url && isSitePath(w.pathname + w.search)
      && !['/login', '/desktop/session'].includes(w.pathname) ? w.pathname + w.search : undefined;
    engine.call('account.webSession')
      .then((ticket) => window.unlockSite(ticket, next))
      .catch((err) => console.error(`[APP] website sign-in with the device failed: ${err.message}`));
  };
  // The site's "Sign out" (site preload). Signed in here, that is signing out
  // of the app: confirm, end the site session, revoke this computer (syncs
  // stop, local files stay); the sign-in screen follows (plain mode).
  // 'site': nothing to sign out of here, the site logs itself out.
  const signOut = async () => {
    const a = sync.account;
    if (!a || !a.signed_in) return 'site';
    if (signingOut) return 'cancelled';
    signingOut = true; // also one confirmation at a time
    try {
      const { response } = await dialog.showMessageBox(window.win, {
        type: 'question',
        buttons: ['Cancel', 'Sign out'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        title: 'Sign out',
        message: 'Sign out of ONE.GY on this computer?',
        detail: `Syncing stops and this computer is removed from ${a.username}'s devices. Files on this computer stay where they are.`,
      });
      if (response !== 1) return 'cancelled';
      await window.clearSiteSession();
      await engine.call('account.signOut', { revoke: true });
      await sync.loadAccount();
      return 'done';
    } catch (err) {
      console.error(`[APP] sign out failed: ${err.message}`);
      dialog.showErrorBox('Could not sign out', err.message);
      return 'cancelled';
    } finally {
      signingOut = false;
    }
  };
  const lockNow = () => {
    const a = sync.account;
    if (!a || !a.signed_in || !a.lock_enabled || a.app_locked) return;
    engine.call('account.appLock').catch((err) => console.error(`[APP] lock failed: ${err.message}`));
  };

  sync.on('change', () => {
    tray.update({
      authorized: sync.authorized(), status: sync.status, engineState: sync.engineState,
      appLocked: appLocked(sync.account), canLock: Boolean(sync.account && sync.account.lock_enabled),
    });
    updatePowerSave();
    pushSiteStatus();
    applySiteMode().catch((err) => console.error(`[APP] site mode: ${err.message}`));
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

  app.on('second-instance', () => {
    if (window) window.show();
    if (updater) updater.checkNow();
  });
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
      siteStatus: () => sync.forUser(window.siteUser),
      onSiteMutation: () => engine.call('engine.nudge').catch(() => {}),
      onSyncShortcut: () => { if (sync.authorized()) openPanel('syncs'); },
      onSiteNavigate,
    });
    const startHidden = process.argv.includes('--hidden') || settings.get().start_minimized || relaunchHidden;
    // The site loads once the engine says whether the app is locked (applySiteMode).
    const win = window.create({ show: !startHidden, loadSite: false });
    setTimeout(() => { if (siteMode === null) applySiteMode('plain'); }, SITE_DECIDE_MAX_MS);
    powerMonitor.on('lock-screen', lockNow);
    powerMonitor.on('suspend', lockNow);
    setInterval(() => {
      const minutes = settings.get().lock_after_minutes;
      if (minutes && powerMonitor.getSystemIdleTime() >= minutes * 60) lockNow();
    }, IDLE_CHECK_MS);
    win.on('close', (e) => {
      if (state.quitting) return;
      if (settings.get().close_to_tray) {
        e.preventDefault();
        win.hide();
      } else {
        app.quit();
      }
    });

    registerIpc({ window, engine, settings, sync, lockNow, signOut });
    watchEnvironment({ powerMonitor, engine });

    tray = new AppTray({
      open: () => window.show(),
      lock: lockNow,
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

    updater = startUpdater({
      settings,
      canRestart: () => {
        if (sync.status && sync.status.state === 'syncing') return false;
        return !win.isVisible() || win.isMinimized() || powerMonitor.getSystemIdleTime() >= UPDATE_IDLE_S;
      },
      beforeRestart: async () => {
        if (!win.isVisible()) fs.writeFileSync(hiddenMarker, '');
        state.quitting = true;
        await engine.stop();
        state.engineStopped = true;
      },
      relaunch: () => {
        app.relaunch({ args: [] });
        app.quit();
      },
    });

    engine.start();
  });
}
