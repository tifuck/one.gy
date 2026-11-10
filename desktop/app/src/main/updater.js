// Updates that ask before they restart. The app checks every 30 minutes, on
// resume and on relaunch (Settings > General > Check for updates any time),
// and the update toast (ui/update.html) offers the one step left; the restart
// comes back where the user was (main.js relaunch-state.json).
// Windows NSIS and Linux AppImage: electron-updater (generic provider on this
// repository's latest GitHub release: latest.yml / latest-linux.yml, or
// beta*.yml on the beta channel) downloads in the background; Restart now
// installs it silently and relaunches.
// Linux .deb / .rpm: installing takes root. The app reads latest-linux.yml
// itself; Update and restart starts onegy-desktop-update.service, the same
// root job the timer from build/linux/after-install.sh runs every 30 minutes
// (resources/update-system.sh, which installs with the system package
// manager). Its polkit rule lets the signed-in user start just that unit;
// without it the system asks for the password. When the timer installs on its
// own, the app notices its files were replaced and asks to restart.
// A ready update restarts by itself only while the window is hidden in the
// tray or minimized (canAutoRestart) and auto_update is on.
'use strict';

const path = require('path');
const { execFile } = require('child_process');
const { app, net, powerMonitor } = require('electron');

const FEED_URL = 'https://github.com/tifuck/one.gy/releases/latest/download';
const CHECK_EVERY_MS = 30 * 60 * 1000;
const RESTART_POLL_MS = 60 * 1000;
const SYSTEM_UNIT = 'onegy-desktop-update.service';
const SYSTEM_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

// 'nsis' | 'appimage' | 'deb' | 'rpm', or null when this build cannot update itself.
function installKind() {
  if (!app.isPackaged) return null;
  if (process.platform === 'win32') return 'nsis';
  if (process.platform !== 'linux') return null;
  if (process.env.APPIMAGE) return 'appimage';
  try {
    const kind = require('original-fs').readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
    return kind === 'deb' || kind === 'rpm' ? kind : null;
  } catch {
    return null;
  }
}

// The version a latest*.yml announces, or null.
function feedVersion(yml) {
  const m = /^version:\s*['"]?([^'"\s]+)/m.exec(String(yml));
  return m ? m[1] : null;
}

// a newer than b, by major.minor.patch.
// ponytail: pre-release suffixes are ignored; the deb/rpm feed is stable only.
function isNewer(a, b) {
  const parts = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v)) || []).slice(1).map(Number);
  const x = parts(a);
  const y = parts(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// systemctl's own reason (stderr), e.g. "Access denied" when the password prompt was cancelled.
function systemctlError(err) {
  const line = String(err.stderr || '').trim().split('\n')[0];
  return line || err.message;
}

// opts: { settings, onChange(state), canAutoRestart(): bool, beforeRestart(): Promise, relaunch() }
// state: { supported, kind, state, current, version, progress, error, failed, checked_at }
//   state: idle | checking | current | downloading | available | installing | ready | error
//   failed: 'check' | 'install' when state is error
// Returns { state(), check(), install() }; install() also restarts into a ready update.
function startUpdater({
  settings, onChange, canAutoRestart, beforeRestart, relaunch,
}) {
  const kind = installKind();
  let s = {
    supported: Boolean(kind), kind, state: 'idle', current: app.getVersion(), version: null, progress: null, error: null, failed: null, checked_at: null,
  };
  const set = (patch) => {
    s = { ...s, ...patch };
    onChange(s);
  };
  if (!kind) return { state: () => s, check: async () => s, install: async () => s };

  let apply = null; // () => void that quits into the new version, once ready
  let restarting = false;
  const restart = async () => {
    if (!apply || restarting) return;
    restarting = true;
    console.log(`[UPDATE] restarting into ${s.version || 'the new version'}`);
    await beforeRestart();
    apply();
  };
  setInterval(() => {
    if (s.state === 'ready' && settings.get().auto_update && canAutoRestart()) restart();
  }, RESTART_POLL_MS);

  const busy = () => ['checking', 'downloading', 'installing', 'ready'].includes(s.state);
  const fail = (failed, message) => {
    console.error(`[UPDATE] ${failed} failed: ${message}`);
    set({ state: 'error', failed, error: message, progress: null });
  };

  let check;
  let install;
  if (kind === 'deb' || kind === 'rpm') {
    // The package manager replaces app.asar by rename: a new inode means a new install.
    const fs = require('original-fs');
    const asar = path.join(process.resourcesPath, 'app.asar');
    const inode = () => { try { return fs.statSync(asar).ino; } catch { return null; } };
    const started = inode();
    const installed = () => {
      const now = inode();
      return now !== null && now !== started;
    };
    const markReady = () => {
      if (s.state === 'ready') return;
      console.log('[UPDATE] new version installed, asking to restart');
      apply = relaunch;
      set({ state: 'ready', error: null, failed: null });
    };
    setInterval(() => { if (installed()) markReady(); }, RESTART_POLL_MS);

    check = async () => {
      if (busy()) return s;
      set({ state: 'checking', error: null, failed: null });
      try {
        const res = await net.fetch(`${FEED_URL}/latest-linux.yml`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const latest = feedVersion(await res.text());
        if (!latest) throw new Error('no version in latest-linux.yml');
        set({ state: isNewer(latest, s.current) ? 'available' : 'current', version: latest, checked_at: new Date().toISOString() });
      } catch (err) {
        fail('check', `Could not check for updates: ${err.message}`);
      }
      if (installed()) markReady();
      return s;
    };
    install = async () => {
      if (s.state === 'ready') return restart().then(() => s);
      if (busy()) return s;
      set({ state: 'installing', error: null, failed: null });
      console.log(`[UPDATE] starting ${SYSTEM_UNIT}`);
      // Waits for the oneshot job (or joins the timer's run).
      const res = await new Promise((resolve) => {
        execFile('systemctl', ['start', SYSTEM_UNIT], { timeout: SYSTEM_INSTALL_TIMEOUT_MS }, (err, _out, stderr) => resolve(err ? Object.assign(err, { stderr }) : null));
      });
      if (res) {
        fail('install', `The update could not be installed: ${systemctlError(res)}`);
        return s;
      }
      if (!installed()) {
        fail('install', 'The system updater installed nothing. Try again in a few minutes.');
        return s;
      }
      markReady();
      await restart();
      return s;
    };
  } else {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = {
      info: (m) => console.log(`[UPDATE] ${m}`),
      warn: (m) => console.warn(`[UPDATE] ${m}`),
      error: (m) => console.error(`[UPDATE] ${m}`),
      debug: () => {},
    };
    const checked = () => new Date().toISOString();
    autoUpdater.on('update-not-available', () => set({ state: 'current', checked_at: checked() }));
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, progress: 0, checked_at: checked() }));
    autoUpdater.on('download-progress', (p) => {
      const pct = Math.floor(p.percent || 0);
      if (s.state === 'downloading' && pct !== s.progress) set({ progress: pct });
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`[UPDATE] ${info.version} downloaded, asking to restart`);
      apply = () => autoUpdater.quitAndInstall(true, true);
      set({ state: 'ready', version: info.version, progress: null });
    });
    autoUpdater.on('error', (err) => { if (s.state !== 'ready') fail('check', err.message); });

    check = async () => {
      if (busy()) return s;
      autoUpdater.channel = settings.get().update_channel === 'beta' ? 'beta' : 'latest';
      autoUpdater.allowDowngrade = false; // the channel setter turns it on
      set({ state: 'checking', error: null, failed: null });
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        if (s.state === 'checking') fail('check', err.message);
      }
      return s;
    };
    install = async () => (s.state === 'ready' ? restart().then(() => s) : check());
  }

  const autoCheck = () => { if (settings.get().auto_update) check(); };
  setTimeout(autoCheck, 15000);
  setInterval(autoCheck, CHECK_EVERY_MS);
  powerMonitor.on('resume', () => setTimeout(autoCheck, 15000));
  return { state: () => s, check, install, autoCheck };
}

module.exports = {
  startUpdater, installKind, feedVersion, isNewer, FEED_URL,
};
