'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultRouteIface, parseNmcliMetered, parseWindowsCost } = require('../src/main/environment');
const { removeSync } = require('../src/main/remove-sync');

test('default route interface from /proc/net/route', () => {
  const table = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
    'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF',
    'wlp2s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000',
  ].join('\n');
  assert.strictEqual(defaultRouteIface(table), 'wlp2s0');
  assert.strictEqual(defaultRouteIface('Iface\tDestination\n'), null);
});

test('metered parsing', () => {
  assert.strictEqual(parseNmcliMetered('GENERAL.METERED:yes\n'), true);
  assert.strictEqual(parseNmcliMetered('GENERAL.METERED:yes (guessed)\n'), true);
  assert.strictEqual(parseNmcliMetered('GENERAL.METERED:no (guessed)\n'), false);
  assert.strictEqual(parseNmcliMetered(''), false);
  assert.strictEqual(parseWindowsCost('Unrestricted\r\n'), false);
  assert.strictEqual(parseWindowsCost('Unknown'), false);
  assert.strictEqual(parseWindowsCost('Fixed\r\n'), true);
  assert.strictEqual(parseWindowsCost('Variable'), true);
});

test('removeSync trashes the folder only while its marker names the sync', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onegy-rm-'));
  fs.mkdirSync(path.join(root, '.onegy'));
  const calls = [];
  const trashed = [];
  const engine = { call: async (m, p) => { calls.push([m, p]); return m === 'syncs.list' ? [{ id: 's_1', local_path: root }] : {}; } };
  const deps = { engine, trash: async (p) => trashed.push(p) };

  fs.writeFileSync(path.join(root, '.onegy', 'sync.json'), JSON.stringify({ sync_id: 's_other' }));
  await assert.rejects(removeSync(deps, 's_1', { deleteLocal: true }), { code: 'marker_mismatch' });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['syncs.list'], 'nothing removed on a mismatch');

  fs.writeFileSync(path.join(root, '.onegy', 'sync.json'), JSON.stringify({ sync_id: 's_1' }));
  await removeSync(deps, 's_1', { deleteLocal: true, releaseBackup: true });
  assert.deepStrictEqual(calls.at(-1), ['syncs.remove', { id: 's_1', release_backup: true }]);
  assert.deepStrictEqual(trashed, [root]);

  await removeSync(deps, 's_1', {});
  assert.strictEqual(trashed.length, 1, 'no trash without deleteLocal');
  fs.rmSync(root, { recursive: true, force: true });
});
