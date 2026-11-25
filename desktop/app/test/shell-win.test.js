'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const win = require('../src/main/shell-win');

// execFile stand-in: records reg.exe calls; fail(args) decides the outcome.
function fakeExecFile(fail = () => false) {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ file, args });
    assert.equal(opts.windowsHide, true);
    setImmediate(() => cb(fail(args) ? Object.assign(new Error('reg failed'), { code: 1 }) : null, '', ''));
  };
  return { calls, execFile };
}

test('install adds "Open on one.gy" for files and folders under HKCU', async () => {
  const exe = 'C:\\Program Files\\ONE.GY "Desktop"\\ONE.GY.exe';
  const { calls, execFile } = fakeExecFile();
  await win.install({ exe, execFile });
  assert.ok(calls.every((c) => /[\\/]System32[\\/]reg\.exe$/.test(c.file)));
  const args = calls.map((c) => c.args);
  for (const key of ['HKCU\\Software\\Classes\\*\\shell\\ONEGY.Open', 'HKCU\\Software\\Classes\\Directory\\shell\\ONEGY.Open']) {
    assert.deepEqual(args.filter((a) => a[1] === key || a[1] === `${key}\\command`), [
      ['add', key, '/v', 'MUIVerb', '/t', 'REG_SZ', '/d', 'Open on one.gy', '/f'],
      ['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', `${exe},0`, '/f'],
      ['add', key, '/v', 'MultiSelectModel', '/t', 'REG_SZ', '/d', 'Single', '/f'],
      ['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}" --open-item="%1"`, '/f'],
    ]);
  }
  assert.equal(args.length, 8);
  assert.ok(args.every((a) => a[1].startsWith('HKCU\\')), 'per user only');
});

test('install stops at the first reg.exe failure', async () => {
  const { calls, execFile } = fakeExecFile((args) => args[3] === 'Icon');
  await assert.rejects(win.install({ exe: 'C:\\a.exe', execFile }), /reg failed/);
  assert.equal(calls.length, 2);
});

test('uninstall deletes the keys that exist and skips missing ones', async () => {
  const files = 'HKCU\\Software\\Classes\\*\\shell\\ONEGY.Open';
  const dirs = 'HKCU\\Software\\Classes\\Directory\\shell\\ONEGY.Open';
  const { calls, execFile } = fakeExecFile((args) => args[0] === 'query' && args[1] === dirs);
  await win.uninstall({ execFile });
  assert.deepEqual(calls.map((c) => c.args), [['query', files], ['delete', files, '/f'], ['query', dirs]]);
});
