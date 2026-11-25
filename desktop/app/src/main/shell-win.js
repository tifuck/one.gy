// Windows File Explorer context menu: see shell-integration.js. "Open on
// one.gy" on files and folders, per user (HKCU, no elevation), through
// reg.exe. The status icons are not set here: they come from the engine's
// Cloud Files placeholders (engine setting windows_explorer_status).
'use strict';

const cp = require('child_process');
const path = require('path');

const KEYS = ['HKCU\\Software\\Classes\\*\\shell\\ONEGY.Open', 'HKCU\\Software\\Classes\\Directory\\shell\\ONEGY.Open'];

const regExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');

// The reg.exe argument lists that add the entries for exe.
function addCommands(exe) {
  return KEYS.flatMap((key) => [
    ['add', key, '/v', 'MUIVerb', '/t', 'REG_SZ', '/d', 'Open on one.gy', '/f'],
    ['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', `${exe},0`, '/f'],
    ['add', key, '/v', 'MultiSelectModel', '/t', 'REG_SZ', '/d', 'Single', '/f'],
    ['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}" --open-item="%1"`, '/f'],
  ]);
}

function reg(execFile, args) {
  return new Promise((resolve, reject) => {
    execFile(regExe(), args, { windowsHide: true, timeout: 15000 }, (err) => (err ? reject(err) : resolve()));
  });
}

async function install({ exe, execFile = cp.execFile }) {
  for (const args of addCommands(exe)) await reg(execFile, args);
}

async function uninstall({ execFile = cp.execFile } = {}) {
  for (const key of KEYS) {
    const present = await reg(execFile, ['query', key]).then(() => true, () => false);
    if (present) await reg(execFile, ['delete', key, '/f']);
  }
}

module.exports = { install, uninstall, addCommands };
