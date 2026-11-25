// Dolphin (KDE): see shell-linux.js. The "Open on one.gy" service menu, per
// user: kio/servicemenus (KF6, and KF5 since 5.85) and kservices5/ServiceMenus
// (older KF5); KIO shows a file name once. The status overlays come from the
// plugin in desktop/shell/dolphin, which the deb / rpm install system-wide.
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = 'onegy-open.desktop';
const dirs = (dataHome) => [path.join(dataHome, 'kio', 'servicemenus'), path.join(dataHome, 'kservices5', 'ServiceMenus')];

// One Exec argument (Desktop Entry spec): double-quoted with " ` $ \ escaped,
// then \ escaped again for the string value; % doubled for field codes.
function execArg(s) {
  if (/[\r\n]/.test(s)) throw new Error('program path has a line break');
  return `"${s.replace(/["`$\\]/g, '\\$&')}"`.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

function serviceMenu(exe) {
  // KF6 needs the file executable, KF5 the ServiceTypes key.
  return [
    '[Desktop Entry]',
    'Type=Service',
    'ServiceTypes=KonqPopupMenu/Plugin',
    'MimeType=application/octet-stream;inode/directory;',
    'X-KDE-Protocols=file',
    'X-KDE-Priority=TopLevel',
    'Actions=openOnOnegy;',
    '',
    '[Desktop Action openOnOnegy]',
    'Name=Open on one.gy',
    'Icon=onegy-desktop',
    `Exec=${execArg(exe)} --open-item=%f`,
    '',
  ].join('\n');
}

// { exe, dataHome }
async function install({ exe, dataHome }) {
  const body = serviceMenu(exe);
  for (const dir of dirs(dataHome)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, FILE), body, { mode: 0o755 });
    fs.chmodSync(path.join(dir, FILE), 0o755);
  }
}

// { dataHome }
async function uninstall({ dataHome }) {
  for (const dir of dirs(dataHome)) fs.rmSync(path.join(dir, FILE), { force: true });
}

module.exports = { install, uninstall, serviceMenu };
