// Engine supervisor: connects to onegy-engine over the socket/pipe from
// desktop/docs/engine-ipc.md, spawns it when nothing is listening, restarts it
// with backoff after a crash, and re-emits engine events. Pure Node.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { RpcClient, RpcError } = require('./rpc');

const CONNECT_POLL_MS = 250;
const STARTUP_TIMEOUT_MS = 20000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const STABLE_AFTER_MS = 60000;
const SHUTDOWN_TIMEOUT_MS = 15000;

function stateDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ONE.GY');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'onegy');
}

function defaultSocketPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return `\\\\.\\pipe\\onegy-engine-${env.USERNAME || os.userInfo().username}`;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'onegy', 'engine.sock');
  return path.join(stateDir(platform, env, home), 'run', 'engine.sock');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Emits: 'state' ('connecting'|'connected'|'disconnected'|'missing'), 'event' ({type, data}).
class EngineSupervisor extends EventEmitter {
  // command: executable to spawn; args: extra args; env: extra env vars.
  constructor({ command, args = [], env = {}, socketPath = defaultSocketPath() }) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.socketPath = socketPath;
    this.client = null;
    this.child = null;
    this.state = 'disconnected';
    this.stopping = false;
    this.backoff = BACKOFF_MIN_MS;
    this.connectedAt = 0;
    this.loop = null;
    // Handed to the engine we spawn on stdin (--ipc-secret-stdin) and presented
    // with ipc.hello: other programs of this user cannot drive the engine.
    this.secret = crypto.randomBytes(32).toString('hex');
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  start() {
    if (!this.loop) this.loop = this.run().finally(() => { this.loop = null; });
    return this.loop;
  }

  async run() {
    while (!this.stopping && !this.client) {
      this.setState('connecting');
      if (await this.tryConnect()) return;
      if (!this.child) {
        if (!this.spawnEngine()) {
          this.setState('missing');
          await sleep(this.nextBackoff());
          continue;
        }
      }
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      while (!this.stopping && this.child && Date.now() < deadline) {
        if (await this.tryConnect()) return;
        await sleep(CONNECT_POLL_MS);
      }
      if (this.stopping) return;
      this.setState('disconnected');
      await sleep(this.nextBackoff());
    }
  }

  nextBackoff() {
    const ms = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    return ms;
  }

  async tryConnect() {
    let client;
    try {
      client = await RpcClient.connect(this.socketPath);
    } catch {
      return false;
    }
    try {
      await client.call('ipc.hello', { secret: this.secret });
    } catch (err) {
      if (err.code === 'forbidden') {
        // An engine started by an earlier run of the app (it crashed): its
        // secret is gone. Ask it to exit; run() then starts ours.
        console.error('[ENGINE] running engine has another IPC secret; restarting it');
        await client.call('engine.shutdown').catch(() => {});
        client.close();
        return false;
      }
    }
    this.client = client;
    this.connectedAt = Date.now();
    client.on('event', (ev) => this.emit('event', ev));
    client.on('close', () => this.onClientClose(client));
    try {
      await client.call('engine.subscribe');
    } catch (err) {
      console.error(`[ENGINE] subscribe failed: ${err.message}`);
    }
    if (this.client !== client) return false;
    this.setState('connected');
    return true;
  }

  onClientClose(client) {
    if (this.client !== client) return;
    this.client = null;
    if (Date.now() - this.connectedAt > STABLE_AFTER_MS) this.backoff = BACKOFF_MIN_MS;
    this.setState('disconnected');
    if (!this.stopping) setTimeout(() => this.start(), this.nextBackoff());
  }

  spawnEngine() {
    if (!this.command || !fs.existsSync(this.command)) {
      console.error(`[ENGINE] binary not found: ${this.command}`);
      return false;
    }
    const child = spawn(this.command, [...this.args, '--socket', this.socketPath, '--ipc-secret-stdin'], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stdin.end(`${this.secret}\n`);
    console.log(`[ENGINE] started pid ${child.pid}`);
    const forward = (stream) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        for (const line of chunk.split('\n')) if (line.trim()) console.log(`[ENGINE] ${line}`);
      });
    };
    forward(child.stdout);
    forward(child.stderr);
    child.on('error', (err) => console.error(`[ENGINE] spawn failed: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      console.log(`[ENGINE] exited code=${code} signal=${signal}`);
    });
    return true;
  }

  call(method, params, opts) {
    if (!this.client) return Promise.reject(new RpcError('The sync engine is not running', 'engine_unavailable'));
    return this.client.call(method, params, opts);
  }

  // Asks the engine to reach a safe point and exit; kills it only if it hangs.
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (this.client) {
      try { await this.client.call('engine.shutdown', undefined, { timeoutMs: SHUTDOWN_TIMEOUT_MS }); } catch { /* exits anyway */ }
      this.client.close();
      this.client = null;
    }
    if (child && child.exitCode === null) {
      const exited = await Promise.race([
        new Promise((r) => child.once('exit', () => r(true))),
        sleep(SHUTDOWN_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) child.kill();
    }
    this.setState('disconnected');
  }
}

module.exports = { EngineSupervisor, defaultSocketPath, stateDir };
