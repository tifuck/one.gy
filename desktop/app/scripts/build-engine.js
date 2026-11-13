// Builds the onegy binary (client/cmd/onegy: CLI + sync engine) for the
// current OS into resources/engine/, where electron-builder picks it up
// (extraResources). The app runs it as `onegy daemon`; the installers put it on
// PATH as the CLI, so Windows gets a console build (spawned with windowsHide).
// Needs Go on PATH.
//   node scripts/build-engine.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const CLIENT = path.join(APP, '..', '..', 'client');
const version = fs.readFileSync(path.join(CLIENT, 'VERSION'), 'utf8').trim();
const exe = process.platform === 'win32' ? 'onegy.exe' : 'onegy';
const out = path.join(APP, 'resources', 'engine', exe);

// bundled=1: this copy updates with the app, never by itself.
const ldflags = ['-s', '-w', `-X github.com/tifuck/one.gy/client/internal/config.Version=${version}`, '-X main.bundled=1'];

fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags.join(' '), '-o', out, './cmd/onegy'], {
  cwd: CLIENT,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0' },
});
console.log(`built ${path.relative(APP, out)} (${version})`);
