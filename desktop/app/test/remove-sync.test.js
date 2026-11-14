'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { markerMatches } = require('../src/main/remove-sync');

test('the sync marker: match, other sync, missing, not JSON, unreadable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onegy-marker-'));
  assert.equal(await markerMatches(root, 's1'), false);
  fs.mkdirSync(path.join(root, '.onegy'));
  const marker = path.join(root, '.onegy', 'sync.json');
  fs.writeFileSync(marker, 'null');
  assert.equal(await markerMatches(root, 's1'), false);
  fs.writeFileSync(marker, '{not json');
  assert.equal(await markerMatches(root, 's1'), false);
  fs.writeFileSync(marker, JSON.stringify({ sync_id: 's2' }));
  assert.equal(await markerMatches(root, 's1'), false);
  fs.writeFileSync(marker, JSON.stringify({ sync_id: 's1' }));
  assert.equal(await markerMatches(root, 's1'), true);
  fs.rmSync(marker);
  fs.mkdirSync(marker); // EISDIR: neither missing nor another sync's
  await assert.rejects(markerMatches(root, 's1'), { code: 'marker_unreadable' });
});
