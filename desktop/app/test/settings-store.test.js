'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SettingsStore, DEFAULTS, normalizeServerUrl } = require('../src/main/settings-store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onegy-settings-'));

test('defaults when no file exists', () => {
  const s = new SettingsStore(tmpDir());
  assert.deepEqual(s.get(), { ...DEFAULTS, notify: { ...DEFAULTS.notify } });
});

test('server URL must be https and is reduced to its origin', () => {
  assert.equal(normalizeServerUrl('https://example.org/files?x=1'), 'https://example.org');
  assert.equal(normalizeServerUrl(' https://example.org:8443 '), 'https://example.org:8443');
  assert.equal(normalizeServerUrl('http://example.org'), undefined);
  assert.equal(normalizeServerUrl('https://user:pw@example.org'), undefined);
  assert.equal(normalizeServerUrl('javascript:alert(1)'), undefined);
  assert.equal(normalizeServerUrl(42), undefined);
});

test('set validates, persists atomically and reloads', () => {
  const dir = tmpDir();
  const s = new SettingsStore(dir);
  const { settings, errors } = s.set({
    theme: 'frost', close_to_tray: false, notify: { transfer: false, bogus: true },
    server_url: 'ftp://nope', unknown_key: 1, launch_at_login: 'yes',
  });
  assert.equal(settings.theme, 'frost');
  assert.equal(settings.close_to_tray, false);
  assert.equal(settings.notify.transfer, false);
  assert.equal(settings.notify.conflict, true);
  assert.equal(settings.server_url, DEFAULTS.server_url);
  assert.equal(settings.launch_at_login, true);
  assert.deepEqual(errors.sort(), ['invalid launch_at_login', 'invalid server_url', 'invalid unknown_key']);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  assert.deepEqual(new SettingsStore(dir).get(), settings);
});

test('a corrupt file falls back to defaults and is kept aside', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
  const s = new SettingsStore(dir);
  assert.equal(s.get().theme, DEFAULTS.theme);
  s.set({ theme: 'frost' });
  const aside = fs.readdirSync(dir).find((f) => f.startsWith('settings.json.corrupt-'));
  assert.ok(aside);
  assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), '{not json');
});

test('a failed save changes nothing', () => {
  const dir = tmpDir();
  const s = new SettingsStore(dir);
  let fired = false;
  s.onChange(() => { fired = true; });
  fs.mkdirSync(path.join(dir, `settings.json.${process.pid}.tmp`)); // the temp file cannot be written
  assert.throws(() => s.set({ theme: 'frost' }), { code: 'EISDIR' });
  assert.equal(s.get().theme, DEFAULTS.theme);
  assert.equal(fired, false);
});

test('onChange gets the new and previous values', () => {
  const s = new SettingsStore(tmpDir());
  const seen = [];
  s.onChange((next, before) => seen.push([before.theme, next.theme]));
  s.set({ theme: 'frost' });
  assert.deepEqual(seen, [['frost-dark', 'frost']]);
});
