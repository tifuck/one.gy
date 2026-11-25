'use strict';

// JSON-RPC client and engine supervisor against dev/mock-engine.js, which
// speaks the engine's protocol on its stdin and stdout (engine-ipc.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { RpcClient, LineDecoder } = require('../src/main/rpc');
const { EngineSupervisor, defaultSocketPath, stateDir } = require('../src/main/engine');

const MOCK = path.join(__dirname, '..', 'dev', 'mock-engine.js');

function socketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\onegy-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onegy-ipc-')), 'engine.sock');
}


const waitFor = (emitter, event, pred = () => true, ms = 10000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
  const on = (v) => { if (pred(v)) { clearTimeout(timer); emitter.off(event, on); resolve(v); } };
  emitter.on(event, on);
});

test('socket paths follow engine-ipc.md', () => {
  assert.equal(defaultSocketPath('win32', { USERNAME: 'alice' }), '\\\\.\\pipe\\onegy-engine-alice');
  assert.equal(defaultSocketPath('linux', { XDG_RUNTIME_DIR: '/run/user/1000' }), path.join('/run/user/1000', 'onegy', 'engine.sock'));
  assert.equal(defaultSocketPath('linux', {}, '/h'), path.join('/h', '.local', 'share', 'onegy', 'run', 'engine.sock'));
  assert.equal(stateDir('linux', { XDG_DATA_HOME: '/d' }, '/h'), path.join('/d', 'onegy'));
  assert.equal(stateDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }), path.join('C:\\Users\\a\\AppData\\Roaming', 'ONE.GY'));
});

test('line decoder handles split and joined frames', () => {
  const lines = [];
  const d = new LineDecoder((l) => lines.push(l));
  d.push('{"a":1}\n{"b"');
  d.push(':2}\r\n\n{"c":3}');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  d.push('\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('rpc client: results, typed errors, events, close', async () => {
  const child = spawn(process.execPath, [MOCK], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const client = new RpcClient(child.stdout, { output: child.stdin });
    const status = await client.call('account.status');
    assert.equal(status.signed_in, true);

    await assert.rejects(client.call('remote.createFolder', { parent_id: null, name: 'a/b' }), (err) => {
      assert.equal(err.code, 'validation_failed');
      return true;
    });
    await assert.rejects(client.call('no.such'), { code: 'not_found' });

    const firstStatus = waitFor(client, 'event', (ev) => ev.type === 'status');
    await client.call('engine.subscribe');
    assert.ok((await firstStatus).data.state);

    const syncEvent = waitFor(client, 'event', (ev) => ev.type === 'sync');
    await client.call('syncs.pause', { id: 's_work' });
    assert.equal((await syncEvent).data.paused, true);

    const closed = waitFor(client, 'close');
    child.kill();
    await closed;
    await assert.rejects(client.call('account.status'), { code: 'engine_unavailable' });
  } finally {
    child.kill();
  }
});

test('supervisor spawns the engine, restarts it after a crash, stops it cleanly', { timeout: 30000 }, async () => {
  const sock = socketPath();
  const sup = new EngineSupervisor({ command: process.execPath, args: [MOCK], socketPath: sock });
  sup.start();
  await waitFor(sup, 'state', (s) => s === 'connected');
  assert.equal((await sup.call('engine.info')).protocol, 1);

  const crashed = sup.child;
  crashed.kill('SIGKILL');
  await waitFor(sup, 'state', (s) => s === 'disconnected');
  await waitFor(sup, 'state', (s) => s === 'connected');
  assert.notEqual(sup.child, crashed);
  assert.equal((await sup.call('account.status')).signed_in, true);

  const child = sup.child;
  const exited = new Promise((r) => child.once('exit', r));
  await sup.stop();
  await exited;
  await assert.rejects(sup.call('account.status'), { code: 'engine_unavailable' });
});

// An engine of its own on the socket (left by a crashed app, any version):
// ours cannot start beside it, so the supervisor asks it to stop and never
// talks to it otherwise.
test('supervisor asks an engine that is already running to stop', { skip: process.platform === 'win32', timeout: 15000 }, async () => {
  const sock = socketPath();
  const asked = [];
  const other = net.createServer((c) => {
    c.setEncoding('utf8');
    c.on('data', (d) => {
      for (const line of d.split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        asked.push(m.method);
        c.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })}\n`);
      }
    });
  });
  await new Promise((r) => other.listen(sock, r));
  // Stands in for an engine that finds the state dir taken: it exits at once.
  const sup = new EngineSupervisor({ command: process.execPath, args: ['-e', 'process.exit(1)', '--'], socketPath: sock });
  const states = [];
  sup.on('state', (s) => states.push(s));
  sup.start();
  await waitFor(sup, 'state', (s) => s === 'disconnected');
  sup.stopping = true;
  other.close();
  assert.deepEqual(asked, ['engine.shutdown']);
  assert.ok(!states.includes('connected'), states.join(','));
  assert.equal(sup.client, null);
});

test('supervisor stops an engine that is still starting', { timeout: 15000 }, async () => {
  // Never answers, like an engine that waits for the key store; it leaves when its stdin ends.
  const sup = new EngineSupervisor({ command: process.execPath, args: ['-e', 'process.stdin.resume().on("end", () => process.exit(0))', '--'], socketPath: socketPath() });
  sup.start();
  while (!sup.child) await new Promise((r) => setTimeout(r, 10));
  const child = sup.child;
  const began = Date.now();
  await sup.stop();
  assert.equal(child.exitCode, 0);
  assert.ok(Date.now() - began < 5000);
});

test('supervisor reports an engine binary that cannot run as missing', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onegy-bin-')), 'onegy');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o644 });
  const sup = new EngineSupervisor({ command: bin, socketPath: socketPath() });
  sup.start();
  await waitFor(sup, 'state', (s) => s === 'missing');
  assert.equal(sup.child, null);
  sup.stopping = true;
});

test('supervisor reports a missing binary', async () => {
  const sup = new EngineSupervisor({ command: path.join(os.tmpdir(), 'no-such-engine'), socketPath: socketPath() });
  sup.start();
  await waitFor(sup, 'state', (s) => s === 'missing');
  sup.stopping = true;
});
