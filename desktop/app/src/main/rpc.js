// JSON-RPC 2.0 client over one stream socket, or over an engine's stdout and
// stdin, newline-delimited JSON framing (desktop/docs/engine-ipc.md). Pure
// Node: no Electron imports.
'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const MAX_LINE = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60000;

class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data || null;
  }
}

// Splits a byte stream into complete lines; keeps the partial tail.
class LineDecoder {
  constructor(onLine) {
    this.onLine = onLine;
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onLine(line);
    }
    if (this.buf.length > MAX_LINE) throw new Error('frame too large');
  }
}

// Emits: 'event' ({type, data}), 'close' (Error|null).
class RpcClient extends EventEmitter {
  // output: where requests go when socket only reads (a child's stdout and stdin).
  constructor(socket, { timeoutMs = DEFAULT_TIMEOUT_MS, output = socket } = {}) {
    super();
    this.socket = socket;
    this.output = output;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    const decoder = new LineDecoder((line) => this.handleLine(line));
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      try { decoder.push(chunk); } catch (err) { socket.destroy(err); }
    });
    socket.on('error', (err) => this.shutdown(err));
    socket.on('close', () => this.shutdown(null));
    if (output !== socket) output.on('error', (err) => this.shutdown(err));
  }

  static connect(socketPath, opts) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const fail = (err) => { socket.destroy(); reject(err); };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        resolve(new RpcClient(socket, opts));
      });
    });
  }

  call(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new RpcError('Engine not connected', 'engine_unavailable'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Engine did not answer ${method}`, 'timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.output.write(JSON.stringify(msg) + '\n');
    });
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      console.error('[ENGINE] dropped a malformed frame');
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.method === 'event' && msg.id === undefined) {
      const p = msg.params;
      if (p && typeof p.type === 'string') this.emit('event', { type: p.type, data: p.data });
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      const e = msg.error;
      const code = (e.data && typeof e.data.code === 'string') ? e.data.code : 'internal';
      entry.reject(new RpcError(String(e.message || 'Engine error'), code, e.data));
    } else {
      entry.resolve(msg.result);
    }
  }

  shutdown(err) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new RpcError('Engine connection closed', 'engine_unavailable'));
    }
    this.pending.clear();
    this.emit('close', err);
  }

  close() {
    this.shutdown(null);
    this.output.end();
    // A child's stdout stays open until it exits: its last writes must not fail.
    if (this.output === this.socket) this.socket.destroy();
  }
}

module.exports = { RpcClient, RpcError, LineDecoder };
