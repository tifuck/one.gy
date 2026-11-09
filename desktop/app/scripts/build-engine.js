// Builds onegy-engine for the current OS into resources/engine/, where
// electron-builder picks it up (extraResources). Needs Go on PATH.
//   node scripts/build-engine.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..');
const ENGINE = path.join(APP, '..', 'engine');
const version = fs.readFileSync(path.join(APP, '..', 'VERSION'), 'utf8').trim();
const exe = process.platform === 'win32' ? 'onegy-engine.exe' : 'onegy-engine';
const out = path.join(APP, 'resources', 'engine', exe);

const ldflags = ['-s', '-w', `-X github.com/tifuck/one.gy/desktop/engine/internal/config.Version=${version}`];
if (process.platform === 'win32') ldflags.push('-H=windowsgui');

fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags.join(' '), '-o', out, './cmd/onegy-engine'], {
  cwd: ENGINE,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0' },
});
console.log(`built ${path.relative(APP, out)} (${version})`);
