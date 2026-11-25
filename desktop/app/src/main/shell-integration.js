// File manager integration (desktop/docs/engine-ipc.md "File manager
// integration"): sync status on the items in the sync folders and an "Open on
// one.gy" entry that starts this app with --open-item=<path>. Per user, no
// root: shell-linux.js installs the extensions for Nautilus, Nemo, Caja and
// Dolphin; shell-win.js the File Explorer context menu entries (the status
// icons there come from the engine's Cloud Files placeholders).
'use strict';

const impl = { linux: './shell-linux', win32: './shell-win' }[process.platform];

// The program the entries start: the AppImage itself, not its mount point.
const appExe = () => process.env.APPIMAGE || process.execPath;

function applyShellIntegration(enabled) {
  if (!impl) return;
  const mod = require(impl);
  Promise.resolve()
    .then(() => (enabled ? mod.install({ exe: appExe() }) : mod.uninstall()))
    .catch((err) => console.error(`[SHELL] file manager integration ${enabled ? 'install' : 'removal'} failed: ${err.message}`));
}

module.exports = { applyShellIntegration, appExe };
