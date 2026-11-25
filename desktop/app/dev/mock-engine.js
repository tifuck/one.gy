// Dev-only stand-in for the sync engine (`onegy daemon --ipc-stdio`): serves
// dev/mock-core.js to the program that started it, requests on stdin, answers
// and events on stdout, with the engine's JSON-RPC framing (engine-ipc.md).
// It exits when its stdin ends, like the engine.
//   node dev/mock-engine.js [--signed-out]
// `npm run dev:mock` makes the app spawn this instead of the real engine.
'use strict';

const os = require('os');
const path = require('path');
const { createMockEngine } = require('./mock-core');
const { LineDecoder } = require('../src/main/rpc');

const argv = process.argv.slice(2);
const engine = createMockEngine({
  home: os.homedir(),
  sep: path.sep,
  platform: process.platform,
  signedIn: !argv.includes('--signed-out'),
});

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
let subscribed = false;
engine.onEvent((ev) => {
  if (subscribed) send({ jsonrpc: '2.0', method: 'event', params: ev });
});

const decoder = new LineDecoder((line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.method !== 'string' || msg.id === undefined) return;
  let reply;
  try {
    if (msg.method === 'engine.subscribe') subscribed = true;
    reply = { jsonrpc: '2.0', id: msg.id, result: engine.call(msg.method, msg.params) };
  } catch (err) {
    reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message, data: err.data || { code: 'internal' } } };
  }
  send(reply);
  if (msg.method === 'engine.subscribe') send({ jsonrpc: '2.0', method: 'event', params: { type: 'status', data: engine.overall() } });
  if (msg.method === 'engine.shutdown') setTimeout(() => process.exit(0), 50);
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => decoder.push(chunk));
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));

setInterval(() => engine.tick(), 1000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
