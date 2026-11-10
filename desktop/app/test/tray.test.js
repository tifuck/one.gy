'use strict';

// require('electron') outside Electron is just the binary path, so the
// template builder runs under plain node.
const test = require('node:test');
const assert = require('node:assert/strict');
const { menuTemplate } = require('../src/main/tray');
const { placePopover, isGnomeWayland } = require('../src/main/tray-popover');

const labels = (items) => items.filter((i) => i.type !== 'separator').map((i) => i.label);
const noop = new Proxy({}, { get: () => () => {} });

test('before authorization the tray only opens the site and quits', () => {
  const items = menuTemplate({ authorized: false, status: { state: 'syncing' }, engineState: 'connected' }, noop);
  assert.deepEqual(labels(items), ['Open ONE.GY', 'Quit ONE.GY']);
});

test('after authorization: status, popover, sync panel, pause, upload', () => {
  const items = menuTemplate({ authorized: true, status: { state: 'up_to_date' }, engineState: 'connected' }, noop);
  assert.deepEqual(labels(items), ['Up to date', 'Status and activity…', 'Open ONE.GY', 'Sync…', 'Pause for 1 hour', 'Pause until resumed', 'Upload…', 'Quit ONE.GY']);
  const paused = menuTemplate({ authorized: true, status: { state: 'paused' }, engineState: 'connected' }, noop);
  assert.ok(labels(paused).includes('Resume syncing'));
});

test('locked: the tray only unlocks or quits; unlocked with a lock: Lock ONE.GY', () => {
  const status = { state: 'up_to_date' };
  const locked = labels(menuTemplate({ authorized: true, status, engineState: 'connected', appLocked: true, canLock: true }, noop));
  assert.deepEqual(locked, ['Up to date', 'Unlock ONE.GY…', 'Quit ONE.GY']);
  const open = labels(menuTemplate({ authorized: true, status, engineState: 'connected', appLocked: false, canLock: true }, noop));
  assert.ok(open.includes('Lock ONE.GY') && open.includes('Sync…'));
});

test('only GNOME on Wayland restarts under XWayland', () => {
  assert.equal(isGnomeWayland({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_TYPE: 'wayland' }), true);
  assert.equal(isGnomeWayland({ XDG_CURRENT_DESKTOP: 'GNOME', WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(isGnomeWayland({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_TYPE: 'x11' }), false);
  assert.equal(isGnomeWayland({ XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland' }), false);
  assert.equal(isGnomeWayland({}), false);
});

test('the popover sits by the tray, against the taskbar, inside the work area', () => {
  const size = { width: 640, height: 400 };
  // Windows, taskbar at the bottom: above the icon, centred on it.
  assert.deepEqual(placePopover(size, { x: 1700, y: 1060 }, { x: 0, y: 0, width: 1920, height: 1040 }), { x: 1272, y: 632 });
  // Icon near the right edge: kept inside.
  assert.deepEqual(placePopover(size, { x: 1900, y: 1060 }, { x: 0, y: 0, width: 1920, height: 1040 }), { x: 1272, y: 632 });
  // GNOME top bar (pointer by the icon): below the bar.
  assert.deepEqual(placePopover(size, { x: 1800, y: 12 }, { x: 0, y: 32, width: 1920, height: 1048 }), { x: 1272, y: 40 });
  // GNOME, anchored at the top bar's right end: top right, under the bar.
  assert.deepEqual(placePopover(size, { x: 1920, y: 32 }, { x: 0, y: 32, width: 1920, height: 1048 }), { x: 1272, y: 40 });
  // Second monitor, taskbar on the left: against the left edge.
  assert.deepEqual(placePopover(size, { x: 1940, y: 900 }, { x: 1968, y: 0, width: 1872, height: 1080 }), { x: 1976, y: 672 });
});
