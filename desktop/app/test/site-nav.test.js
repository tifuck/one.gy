'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSitePath, cleanInset, isLockFreePath } = require('../src/main/site-nav');

test('site paths are same-origin paths only', () => {
  assert.equal(isSitePath('/account/devices'), true);
  assert.equal(isSitePath('/files?x=1'), true);
  assert.equal(isSitePath('//evil.example'), false);
  assert.equal(isSitePath('https://evil.example/x'), false);
  assert.equal(isSitePath('javascript:alert(1)'), false);
  assert.equal(isSitePath('/a b'), false);
  assert.equal(isSitePath('/a\\b'), false);
});

test('only music stays open while the app is locked', () => {
  assert.equal(isLockFreePath('/music'), true);
  assert.equal(isLockFreePath('/files'), false);
  assert.equal(isLockFreePath('/notes'), false);
  assert.equal(isLockFreePath('/desktop/locked'), false);
  assert.equal(isLockFreePath('/music/stream/x'), false);
});

test('rail inset is a small non-negative width', () => {
  assert.equal(cleanInset(68), 68);
  assert.equal(cleanInset(67.6), 68);
  assert.equal(cleanInset(0), 0);
  assert.equal(cleanInset(-1), null);
  assert.equal(cleanInset(5000), null);
  assert.equal(cleanInset(Number.NaN), null);
  assert.equal(cleanInset('68'), null);
});
