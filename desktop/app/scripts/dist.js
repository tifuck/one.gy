// Packages the app with the version from client/VERSION (package.json keeps a
// dev placeholder). Extra args go to electron-builder:
//   node scripts/dist.js                    this OS (Linux: AppImage, deb, rpm)
//   node scripts/dist.js --linux deb rpm    some Linux targets
//   node scripts/dist.js --win nsis
// Linux targets build one electron-builder run each, from a fresh
// linux-unpacked: the deb and rpm targets write resources/package-type (how
// electron-updater tells deb from rpm from AppImage) into the unpacked dir
// that concurrent targets package. The runs' *-linux.yml update files are
// merged so every format finds its file.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const APP = path.join(__dirname, '..');
const DIST = path.join(APP, 'dist');
const LINUX_TARGETS = ['AppImage', 'deb', 'rpm'];
const version = fs.readFileSync(path.join(APP, '..', '..', 'client', 'VERSION'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`bad client/VERSION: ${version}`);

const cli = require.resolve('electron-builder/cli.js');
const build = (args) => {
  const res = spawnSync(process.execPath, [cli, `-c.extraMetadata.version=${version}`, ...args], { cwd: APP, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status === null ? 1 : res.status);
};

const args = process.argv.slice(2);
if (!args.includes('--publish')) args.push('--publish', 'never');
const at = args.indexOf('--linux');
const otherPlatform = args.some((a) => ['--win', '--windows', '-w', '--mac', '--macos', '-m'].includes(a));
if (at < 0 && (process.platform !== 'linux' || otherPlatform)) {
  build(args);
  process.exit(0);
}

let targets = [];
let rest = args;
if (at >= 0) {
  let end = at + 1;
  while (end < args.length && !args[end].startsWith('-')) targets.push(args[end++]);
  rest = [...args.slice(0, at), ...args.slice(end)];
}
if (!targets.length) targets = LINUX_TARGETS;

const updateFiles = () => (fs.existsSync(DIST) ? fs.readdirSync(DIST).filter((n) => n.endsWith('-linux.yml')) : []);
for (const f of updateFiles()) fs.rmSync(path.join(DIST, f));
const merged = new Map();
for (const target of targets) {
  fs.rmSync(path.join(DIST, 'linux-unpacked'), { recursive: true, force: true });
  build(['--linux', target, ...rest]);
  for (const f of updateFiles()) {
    const doc = yaml.load(fs.readFileSync(path.join(DIST, f), 'utf8'));
    if (!merged.has(f)) merged.set(f, { ...doc, files: [] });
    const into = merged.get(f).files;
    for (const file of doc.files || []) if (!into.some((x) => x.url === file.url)) into.push(file);
  }
}
for (const [f, doc] of merged) fs.writeFileSync(path.join(DIST, f), yaml.dump(doc, { lineWidth: -1 }));
console.log(`linux targets ${targets.join(', ')}; update files: ${[...merged.keys()].join(', ') || 'none'}`);
