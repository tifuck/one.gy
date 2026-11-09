'use strict';

// require('electron') outside Electron is just the binary path, so the
// template builder runs under plain node.
const test = require('node:test');
const assert = require('node:assert/strict');
const { menuTemplate } = require('../src/main/tray');

const labels = (items) => items.filter((i) => i.type !== 'separator').map((i) => i.label);
const noop = new Proxy({}, { get: () => () => {} });

test('before authorization the tray only opens the site and quits', () => {
  const items = menuTemplate({ authorized: false, status: { state: 'syncing' }, engineState: 'connected' }, noop);
  assert.deepEqual(labels(items), ['Open ONE.GY', 'Quit ONE.GY']);
});

test('after authorization: status, sync panel, pause, upload', () => {
  const items = menuTemplate({ authorized: true, status: { state: 'up_to_date' }, engineState: 'connected' }, noop);
  assert.deepEqual(labels(items), ['Up to date', 'Open ONE.GY', 'Sync…', 'Pause for 1 hour', 'Pause until resumed', 'Upload…', 'Quit ONE.GY']);
  const paused = menuTemplate({ authorized: true, status: { state: 'paused' }, engineState: 'connected' }, noop);
  assert.ok(labels(paused).includes('Resume syncing'));
});
