'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shortcutFor, nextZoom } = require('../src/main/shortcuts');

const key = (k, mods = {}) => ({ type: 'keyDown', key: k, code: '', ...mods });

test('navigation, reload, zoom and sync shortcuts', () => {
  assert.equal(shortcutFor(key('ArrowLeft', { alt: true })), 'back');
  assert.equal(shortcutFor(key('ArrowRight', { alt: true })), 'forward');
  assert.equal(shortcutFor(key('BrowserBack')), 'back');
  assert.equal(shortcutFor(key('r', { control: true })), 'reload');
  assert.equal(shortcutFor(key('F5')), 'reload');
  assert.equal(shortcutFor(key('R', { control: true, shift: true })), 'hardReload');
  assert.equal(shortcutFor(key('F5', { control: true })), 'hardReload');
  assert.equal(shortcutFor(key('=', { control: true })), 'zoomIn');
  assert.equal(shortcutFor(key('+', { control: true, shift: true })), 'zoomIn');
  assert.equal(shortcutFor(key('-', { control: true })), 'zoomOut');
  assert.equal(shortcutFor(key('0', { control: true })), 'zoomReset');
  assert.equal(shortcutFor(key('S', { control: true, shift: true })), 'sync');
  assert.equal(shortcutFor(key('F12')), 'devtools');
});

test('ordinary typing and key-up are left alone', () => {
  assert.equal(shortcutFor(key('ArrowLeft')), null);
  assert.equal(shortcutFor(key('s', { control: true })), null);
  assert.equal(shortcutFor(key('r')), null);
  assert.equal(shortcutFor(key('0', { control: true, shift: true })), null);
  assert.equal(shortcutFor(key('ArrowLeft', { alt: true, control: true })), null);
  assert.equal(shortcutFor({ ...key('r', { control: true }), type: 'keyUp' }), null);
  assert.equal(shortcutFor(null), null);
});

test('zoom steps stay on the list and clamp at the ends', () => {
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1, -1), 0.9);
  assert.equal(nextZoom(0.95, 1), 1);
  assert.equal(nextZoom(0.95, -1), 0.9);
  assert.equal(nextZoom(3, 1), 3);
  assert.equal(nextZoom(0.5, -1), 0.5);
  assert.equal(nextZoom(2, 0), 1);
});
