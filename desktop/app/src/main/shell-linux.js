// Linux file managers (see shell-integration.js): the shared emblem icons in
// the user's hicolor theme, then the GTK file managers (shell-gtk.js:
// Nautilus, Nemo, Caja) and Dolphin (shell-kde.js).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const EMBLEMS = ['onegy-synced', 'onegy-syncing', 'onegy-error', 'onegy-paused'];
const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const emblemDir = () => path.join(dataHome(), 'icons', 'hicolor', 'scalable', 'emblems');
const parts = () => [require('./shell-gtk'), require('./shell-kde')];

async function each(fn) {
  const errors = [];
  for (const part of parts()) {
    try { await fn(part); } catch (err) { errors.push(err.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

async function install({ exe }) {
  fs.mkdirSync(emblemDir(), { recursive: true });
  for (const name of EMBLEMS) {
    // read + write, not copyFile: the source is inside app.asar
    fs.writeFileSync(path.join(emblemDir(), `${name}.svg`), fs.readFileSync(path.join(__dirname, '..', 'assets', 'emblems', `${name}.svg`)));
  }
  await each((part) => part.install({ exe, dataHome: dataHome() }));
}

async function uninstall() {
  for (const name of EMBLEMS) fs.rmSync(path.join(emblemDir(), `${name}.svg`), { force: true });
  await each((part) => part.uninstall({ dataHome: dataHome() }));
}

module.exports = { install, uninstall, EMBLEMS };
