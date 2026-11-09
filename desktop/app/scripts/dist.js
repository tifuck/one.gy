// Packages the app for the current OS with the version from desktop/VERSION
// (package.json keeps a dev placeholder). Extra args go to electron-builder:
//   node scripts/dist.js [--linux AppImage deb] [--publish never]
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const APP = path.join(__dirname, '..');
const version = fs.readFileSync(path.join(APP, '..', 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`bad desktop/VERSION: ${version}`);

const args = process.argv.slice(2);
if (!args.includes('--publish')) args.push('--publish', 'never');
const cli = require.resolve('electron-builder/cli.js');
const res = spawnSync(process.execPath, [cli, `-c.extraMetadata.version=${version}`, ...args], { cwd: APP, stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
