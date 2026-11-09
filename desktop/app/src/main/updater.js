// Auto-update via electron-updater, generic provider on this repository's
// latest GitHub release (latest.yml / latest-linux.yml, or beta*.yml on the
// beta channel). Packaged builds only: Windows NSIS, Linux AppImage, and the
// Linux .deb / .rpm installs, which electron-updater recognises by the
// resources/package-type file electron-builder writes and installs with the
// system package manager through pkexec (it asks for the system password).
'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

const FEED_URL = 'https://github.com/tifuck/one.gy/releases/latest/download';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

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

// opts: { settings, beforeInstall(): Promise, notify({title, body}), parentWindow() }
function startUpdater({ settings, beforeInstall, notify, parentWindow }) {
  const kind = installKind();
  if (!kind) return { checkNow: async () => ({ supported: false }) };
  const packaged = kind === 'deb' || kind === 'rpm';
  const { autoUpdater } = require('electron-updater');
  autoUpdater.setFeedURL({ provider: 'generic', url: FEED_URL });
  autoUpdater.autoDownload = true;
  // A package install needs the system password: only when the user says so.
  autoUpdater.autoInstallOnAppQuit = !packaged;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = {
    info: (m) => console.log(`[UPDATE] ${m}`),
    warn: (m) => console.warn(`[UPDATE] ${m}`),
    error: (m) => console.error(`[UPDATE] ${m}`),
    debug: () => {},
  };

  let prompted = false;
  autoUpdater.on('error', (err) => console.error(`[UPDATE] ${err.message}`));
  autoUpdater.on('update-downloaded', async (info) => {
    if (prompted) return;
    prompted = true;
    notify({ title: 'Update ready', body: `ONE.GY Desktop ${info.version} installs when you restart.` });
    const { response } = await dialog.showMessageBox(parentWindow(), {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `ONE.GY Desktop ${info.version} is ready to install.`,
      detail: packaged
        ? 'Your system asks for your password to install the package. Syncing pauses for a moment while the app restarts.'
        : 'Syncing pauses for a moment while the app restarts.',
    });
    if (response !== 0) {
      prompted = false;
      return;
    }
    // The package manager installs before the app quits (and may be
    // cancelled), so the engine keeps running until the normal quit.
    if (!packaged) await beforeInstall();
    autoUpdater.quitAndInstall();
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
  return { checkNow: check };
}

module.exports = { startUpdater, installKind, FEED_URL };
