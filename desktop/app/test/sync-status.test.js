'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { SyncStatus, bridgeStatus, sameUser, throttle } = require('../src/main/sync-status');

const alice = { signed_in: true, locked: false, username: 'alice' };
const base = { engineState: 'connected', account: alice, status: { state: 'up_to_date', pending: 0 }, issueCount: 0 };

test('bridge states follow the contract', () => {
  assert.deepEqual(bridgeStatus(base, 'alice'), { state: 'up_to_date', pending: 0, issues: 0 });
  assert.equal(bridgeStatus({ ...base, engineState: 'connecting' }, 'alice').state, 'offline');
  assert.equal(bridgeStatus({ ...base, account: null }, 'alice').state, 'offline');
  assert.equal(bridgeStatus({ ...base, account: { signed_in: false } }, 'alice').state, 'not_set_up');
  assert.equal(bridgeStatus({ ...base, status: { state: 'signed_out' } }, 'alice').state, 'not_set_up');
  assert.equal(bridgeStatus({ ...base, account: { ...alice, locked: true } }, 'alice').state, 'locked');
  for (const s of ['syncing', 'paused', 'offline', 'issues', 'locked']) {
    assert.equal(bridgeStatus({ ...base, status: { state: s } }, 'alice').state, s);
  }
  assert.deepEqual(bridgeStatus({ ...base, status: { state: 'syncing', pending: 7 }, issueCount: 2 }, 'alice'),
    { state: 'syncing', pending: 7, issues: 2 });
});

test('another account never sees this computer\'s numbers', () => {
  const st = bridgeStatus({ ...base, status: { state: 'syncing', pending: 7 }, issueCount: 2 }, 'bob');
  assert.deepEqual(st, { state: 'other_account', pending: 0, issues: 0 });
  assert.equal(bridgeStatus(base, 'ALICE').state, 'up_to_date');
  assert.equal(bridgeStatus(base, null).state, 'up_to_date');
  assert.equal(sameUser('Alice', 'alice'), true);
  assert.equal(sameUser(null, 'alice'), false);
});

test('SyncStatus tracks account, status and issues from engine events', async () => {
  const engine = new EventEmitter();
  engine.state = 'connecting';
  let account = { signed_in: false };
  let issues = [];
  engine.call = async (method) => (method === 'account.status' ? account : issues);
  const s = new SyncStatus(engine);
  let changes = 0;
  s.on('change', () => { changes += 1; });

  engine.state = 'connected';
  engine.emit('state', 'connected');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.forUser('alice').state, 'not_set_up');
  assert.equal(s.authorized(), false);

  account = alice;
  issues = [{ id: 1 }, { id: 2 }];
  engine.emit('event', { type: 'status', data: { state: 'issues', pending: 3 } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.forUser('alice'), { state: 'issues', pending: 3, issues: 2 });
  assert.equal(s.authorized(), true);

  engine.emit('event', { type: 'issue', data: { id: 1, resolved: true } });
  assert.equal(s.forUser('alice').issues, 1);
  engine.emit('event', { type: 'issue', data: { id: 9 } });
  assert.equal(s.forUser('alice').issues, 2);
  assert.ok(changes >= 4);
});

test('throttle runs at most once per window, with the last state', async () => {
  let calls = 0;
  const t = throttle(() => { calls += 1; }, 40);
  t(); t(); t();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  t(); t();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 2);
});
