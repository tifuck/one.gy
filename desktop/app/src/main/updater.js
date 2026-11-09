// Auto-update via electron-updater, generic provider on this repository's
// latest GitHub release (latest.yml / latest-linux.yml, or beta.yml on the
// beta channel). Only for packaged NSIS and AppImage builds: deb updates come
// from the package manager.
'use strict';

const { app, dialog } = require('electron');

const FEED_URL = 'https://github.com/tifuck/one.gy/releases/latest/download';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function updatesSupported() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return true;
  return process.platform === 'linux' && Boolean(process.env.APPIMAGE);
}

// opts: { settings, beforeInstall(): Promise, notify({title, body}), parentWindow() }
function startUpdater({ settings, beforeInstall, notify, parentWindow }) {
  if (!updatesSupported()) return { checkNow: async () => ({ supported: false }) };
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
      detail: 'Syncing pauses for a moment while the app restarts.',
    });
    if (response !== 0) return;
    await beforeInstall();
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

module.exports = { startUpdater, updatesSupported, FEED_URL };
