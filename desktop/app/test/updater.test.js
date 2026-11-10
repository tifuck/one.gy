'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { feedVersion, isNewer } = require('../src/main/updater');

test('feedVersion reads latest-linux.yml', () => {
  assert.equal(feedVersion("version: 0.5.1\nfiles:\n  - url: onegy-desktop_amd64.deb\n"), '0.5.1');
  assert.equal(feedVersion("version: '1.2.3'\n"), '1.2.3');
  assert.equal(feedVersion('files: []\n'), null);
});

test('isNewer compares major.minor.patch numerically', () => {
  assert.ok(isNewer('0.5.1', '0.5.0'));
  assert.ok(isNewer('0.10.0', '0.9.9'));
  assert.ok(!isNewer('0.5.0', '0.5.0'));
  assert.ok(!isNewer('0.4.9', '0.5.0'));
  assert.ok(!isNewer('garbage', '0.5.0'));
});
