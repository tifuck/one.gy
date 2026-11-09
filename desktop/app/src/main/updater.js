// Fully automatic updates, no prompts.
// Windows NSIS and Linux AppImage: electron-updater (generic provider on this
// repository's latest GitHub release: latest.yml / latest-linux.yml, or
// beta*.yml on the beta channel) downloads in the background, then installs
// silently and relaunches once the app is idle (canRestart).
// Linux .deb / .rpm: the root timer from build/linux/after-install.sh runs
// resources/update-system.sh, which installs new releases with the system
// package manager. The app only notices its files were replaced and relaunches
// itself once idle.
'use strict';

const fs = require('original-fs');
const path = require('path');
const { app, powerMonitor } = require('electron');

const FEED_URL = 'https://github.com/tifuck/one.gy/releases/latest/download';
const CHECK_EVERY_MS = 30 * 60 * 1000;
const RESTART_POLL_MS = 60 * 1000;

// 'nsis' | 'appimage' | 'deb' | 'rpm', or null when this build cannot update itself.
function installKind() {
  if (!app.isPackaged) return null;
  if (process.platform === 'win32') return 'nsis';
  if (process.platform !== 'linux') return null;
  if (process.env.APPIMAGE) return 'appimage';
  try {
    const kind = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim();
    return kind === 'deb' || kind === 'rpm' ? kind : null;
  } catch {
    return null;
  }
}

// opts: { settings, canRestart(): bool, beforeRestart(): Promise, relaunch() }
function startUpdater({ settings, canRestart, beforeRestart, relaunch }) {
  const kind = installKind();
  if (!kind) return { checkNow: async () => ({ supported: false }) };

  let pending = null; // () => void that restarts into the new version
  setInterval(async () => {
    if (!pending || !settings.get().auto_update || !canRestart()) return;
    const restart = pending;
    pending = null;
    await beforeRestart();
    restart();
  }, RESTART_POLL_MS);

  if (kind === 'deb' || kind === 'rpm') {
    // The package manager replaces app.asar by rename: a new inode means a new install.
    const asar = path.join(process.resourcesPath, 'app.asar');
    const inode = () => { try { return fs.statSync(asar).ino; } catch { return null; } };
    const started = inode();
    const check = async () => {
      const now = inode();
      if (now !== null && now !== started && !pending) {
        console.log('[UPDATE] new version installed, relaunching when idle');
        pending = relaunch;
      }
      return { supported: true, checked: true };
    };
    setInterval(check, RESTART_POLL_MS);
    return { checkNow: check };
  }

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
  autoUpdater.on('error', (err) => console.error(`[UPDATE] ${err.message}`));
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[UPDATE] ${info.version} downloaded, installing when idle`);
    pending = () => autoUpdater.quitAndInstall(true, true);
  });

  const check = async () => {
    const s = settings.get();
    if (!s.auto_update) return { supported: true, checked: false };
    autoUpdater.channel = s.update_channel === 'beta' ? 'beta' : 'latest';
    autoUpdater.allowDowngrade = false; // the channel setter turns it on
    try {
      const res = await autoUpdater.checkForUpdates();
      return { supported: true, checked: true, version: res && res.updateInfo ? res.updateInfo.version : null };
    } catch (err) {
      return { supported: true, checked: false, error: err.message };
    }
  };
  setTimeout(check, 15000);
  setInterval(check, CHECK_EVERY_MS);
  powerMonitor.on('resume', () => setTimeout(check, 15000));
  return { checkNow: check };
}

module.exports = { startUpdater, installKind, FEED_URL };
