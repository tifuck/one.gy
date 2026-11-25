'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const kde = require('../src/main/shell-kde');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onegy-kde-'));
const files = (home) => [path.join(home, 'kio', 'servicemenus', 'onegy-open.desktop'), path.join(home, 'kservices5', 'ServiceMenus', 'onegy-open.desktop')];

// What KDE runs: KConfig unescapes the value, the Exec line splits like a
// shell (backslash escapes inside double quotes), then %% becomes %.
function argv(body) {
  const line = body.match(/^Exec=(.*)$/m)[1].replace(/\\(.)/g, '$1');
  const args = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '\\') cur += line[++i];
    else if (c === '"') quoted = !quoted;
    else if (c === ' ' && !quoted) { args.push(cur); cur = ''; }
    else cur += c;
  }
  args.push(cur);
  return args.map((a) => a.replace(/%%/g, '%'));
}

test('installs an executable service menu for KF6 and KF5', async () => {
  const home = tmp();
  await kde.install({ exe: '/opt/ONE.GY Desktop/onegy-desktop', dataHome: home });
  for (const f of files(home)) {
    const body = fs.readFileSync(f, 'utf8');
    assert.equal(fs.statSync(f).mode & 0o777, 0o755);
    assert.match(body, /^Name=Open on one\.gy$/m);
    assert.match(body, /^MimeType=application\/octet-stream;inode\/directory;$/m);
    assert.match(body, /^ServiceTypes=KonqPopupMenu\/Plugin$/m);
    assert.match(body, /^Exec="\/opt\/ONE\.GY Desktop\/onegy-desktop" --open-item=%f$/m);
  }
  await kde.install({ exe: '/x', dataHome: home }); // again: overwrites
  assert.match(fs.readFileSync(files(home)[0], 'utf8'), /^Exec="\/x" --open-item=%f$/m);
  await kde.uninstall({ dataHome: home });
  for (const f of files(home)) assert.equal(fs.existsSync(f), false);
  await kde.uninstall({ dataHome: home });
});

test('quotes the program path for the Exec key', () => {
  const exe = '/opt/a "b"/$PATH/`x`/back\\slash/100%/app';
  assert.deepEqual(argv(kde.serviceMenu(exe)), [exe, '--open-item=%f']);
  assert.match(kde.serviceMenu('/a b/c$d'), /^Exec="\/a b\/c\\\\\$d" --open-item=%f$/m);
  assert.throws(() => kde.serviceMenu('/a\nb'), /line break/);
});
