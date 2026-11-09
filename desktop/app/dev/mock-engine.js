// Dev-only stand-in for onegy-engine: serves dev/mock-core.js over the same
// socket/pipe and JSON-RPC framing as the real engine (engine-ipc.md).
//   node dev/mock-engine.js [--socket <path>] [--signed-out]
// `npm run dev:mock` makes the app spawn this instead of the real engine.
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createMockEngine } = require('./mock-core');
const { defaultSocketPath } = require('../src/main/engine');
const { LineDecoder } = require('../src/main/rpc');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const socketPath = flag('socket') || defaultSocketPath();
const engine = createMockEngine({
  home: os.homedir(),
  sep: path.sep,
  platform: process.platform,
  signedIn: !argv.includes('--signed-out'),
});

const clients = new Set();
engine.onEvent((ev) => {
  const line = `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: ev })}\n`;
  for (const c of clients) if (c.subscribed) c.socket.write(line);
});

const server = net.createServer((socket) => {
  const client = { socket, subscribed: false };
  clients.add(client);
  socket.setEncoding('utf8');
  const decoder = new LineDecoder((line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg.method !== 'string' || msg.id === undefined) return;
    let reply;
    try {
      if (msg.method === 'engine.subscribe') client.subscribed = true;
      reply = { jsonrpc: '2.0', id: msg.id, result: engine.call(msg.method, msg.params) };
    } catch (err) {
      reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message, data: err.data || { code: 'internal' } } };
    }
    socket.write(`${JSON.stringify(reply)}\n`);
    if (msg.method === 'engine.subscribe') {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'status', data: engine.overall() } })}\n`);
    }
    if (msg.method === 'engine.shutdown') setTimeout(() => process.exit(0), 50);
  });
  socket.on('data', (chunk) => decoder.push(chunk));
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
});

if (process.platform !== 'win32') {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.rmSync(socketPath, { force: true });
}
server.listen(socketPath, () => {
  if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
  console.log(`[MOCK] listening on ${socketPath}`);
});
setInterval(() => engine.tick(), 1000).unref();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
