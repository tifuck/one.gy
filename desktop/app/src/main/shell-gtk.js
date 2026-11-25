// GTK file managers (Nautilus, Nemo, Caja): see shell-linux.js. One Python
// extension (src/shell/onegy_fm.py) for nautilus-python, nemo-python and
// caja-python, copied into each one's per-user folder with the app's path
// filled in; it picks the file manager by the folder it was loaded from. File
// managers load extensions at start, so a change shows after they restart.
'use strict';

const fs = require('fs');
const path = require('path');

const NAME = 'onegy_fm.py';
const dirs = (dataHome) => ['nautilus-python', 'nemo-python', 'caja-python'].map((fm) => path.join(dataHome, fm, 'extensions'));

// { exe, dataHome }
async function install({ exe, dataHome }) {
  // readFileSync, not copyFile: the source is inside app.asar
  const src = fs.readFileSync(path.join(__dirname, '..', 'shell', NAME), 'utf8');
  const out = src.replace(/^EXE = ''$/m, () => `EXE = ${JSON.stringify(exe)}`); // a JSON string is a Python string
  if (out === src) throw new Error(`${NAME}: no EXE line`);
  for (const dir of dirs(dataHome)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, NAME), out);
  }
}

// { dataHome }
async function uninstall({ dataHome }) {
  for (const dir of dirs(dataHome)) {
    fs.rmSync(path.join(dir, NAME), { force: true });
    let cached = [];
    try { cached = fs.readdirSync(path.join(dir, '__pycache__')); } catch { /* none */ }
    for (const name of cached.filter((n) => n.startsWith('onegy_fm.'))) fs.rmSync(path.join(dir, '__pycache__', name), { force: true });
  }
}

module.exports = { install, uninstall };
