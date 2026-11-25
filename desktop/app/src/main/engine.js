// Engine supervisor: spawns the sync engine (`onegy daemon --ipc-stdio`) and
// talks to it on its stdin and stdout (desktop/docs/engine-ipc.md), a channel
// no other program can take the place of. Restarts it with backoff after a
// crash, asks an engine that is already running (left by a crashed app, or
// started by hand) to make way, and re-emits engine events. Pure Node.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { RpcClient, RpcError } = require('./rpc');

const STARTUP_TIMEOUT_MS = 20000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const STABLE_AFTER_MS = 60000;
const SHUTDOWN_TIMEOUT_MS = 15000;
const OTHER_ENGINE_TIMEOUT_MS = 5000;

function stateDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ONE.GY');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'onegy');
}

// Where the engine listens for the onegy CLI, and where another engine would be.
function defaultSocketPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return `\\\\.\\pipe\\onegy-engine-${env.USERNAME || os.userInfo().username}`;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'onegy', 'engine.sock');
  return path.join(stateDir(platform, env, home), 'run', 'engine.sock');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether child has exited, waiting up to ms for it.
function exited(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', done);
      resolve(false);
    }, ms);
    child.once('exit', done);
  });
}

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
      // The engine of the round before, when its connection ended before it did.
      if (this.child) {
        this.child.stdin.end();
        if (!(await exited(this.child, SHUTDOWN_TIMEOUT_MS))) this.child.kill();
      }
      const child = await this.spawnEngine();
      if (!child) {
        this.setState('missing');
        await sleep(this.nextBackoff());
        continue;
      }
      if (await this.attach(child)) return;
      if (this.stopping) return;
      // It left before it answered: most often another engine holds the state dir.
      await this.stopOtherEngine();
      this.setState('disconnected');
      await sleep(this.nextBackoff());
    }
  }

  nextBackoff() {
    const ms = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    return ms;
  }

  // The engine answers on its stdout once it serves; until then it is starting.
  async attach(child) {
    const client = new RpcClient(child.stdout, { output: child.stdin });
    // Before subscribing: the first events can arrive with its reply.
    client.on('event', (ev) => this.emit('event', ev));
    for (;;) {
      try {
        await client.call('engine.subscribe', undefined, { timeoutMs: STARTUP_TIMEOUT_MS });
        break;
      } catch (err) {
        if (client.closed || this.stopping) return false;
        if (err.code !== 'timeout') {
          console.error(`[ENGINE] did not start (${err.code}): ${err.message}`);
          child.kill();
          return false;
        }
        console.error('[ENGINE] still starting');
      }
    }
    if (client.closed || this.stopping) return false;
    this.client = client;
    this.connectedAt = Date.now();
    client.on('close', (err) => this.onClientClose(client, err));
    this.setState('connected');
    return true;
  }

  // Asks an engine that listens on the socket to exit (engine.shutdown needs
  // no trust): ours can only start once the state dir is free.
  async stopOtherEngine() {
    let other;
    try {
      other = await RpcClient.connect(this.socketPath);
    } catch {
      return;
    }
    console.error('[ENGINE] another engine is running; asking it to stop');
    await other.call('engine.shutdown', undefined, { timeoutMs: OTHER_ENGINE_TIMEOUT_MS }).catch(() => {});
    other.close();
  }

  onClientClose(client, err) {
    if (this.client !== client) return;
    this.client = null;
    if (err) console.error(`[ENGINE] connection lost: ${err.message}`);
    if (Date.now() - this.connectedAt > STABLE_AFTER_MS) this.backoff = BACKOFF_MIN_MS;
    this.setState('disconnected');
    if (!this.stopping) setTimeout(() => this.start(), this.nextBackoff());
  }

  // Resolves the started child, or null when the binary is missing or cannot run.
  spawnEngine() {
    if (!this.command || !fs.existsSync(this.command)) {
      console.error(`[ENGINE] binary not found: ${this.command}`);
      return Promise.resolve(null);
    }
    const child = spawn(this.command, [...this.args, '--socket', this.socketPath, '--ipc-stdio'], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) console.log(`[ENGINE] ${line}`);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      console.log(`[ENGINE] exited code=${code} signal=${signal}`);
    });
    return new Promise((resolve) => {
      // A failed spawn (EACCES, ENOENT) emits 'error' and never 'spawn' or 'exit'.
      child.on('error', (err) => {
        console.error(`[ENGINE] ${child.pid === undefined ? 'spawn failed' : 'error'}: ${err.message}`);
        resolve(null);
      });
      child.once('spawn', () => {
        this.child = child;
        console.log(`[ENGINE] started pid ${child.pid}`);
        resolve(child);
      });
    });
  }

  call(method, params, opts) {
    if (!this.client) return Promise.reject(new RpcError('The sync engine is not running', 'engine_unavailable'));
    return this.client.call(method, params, opts);
  }

  // Asks the engine to reach a safe point and exit; kills it only if it hangs.
  async stop() {
    this.stopping = true;
    const { client, child } = this;
    if (client) {
      try { await client.call('engine.shutdown', undefined, { timeoutMs: SHUTDOWN_TIMEOUT_MS }); } catch { /* exits anyway */ }
      this.client = null;
      client.close();
    } else if (child) {
      // Still starting: the end of its stdin stops it as soon as it serves.
      child.stdin.end();
    }
    if (child && !(await exited(child, SHUTDOWN_TIMEOUT_MS))) child.kill();
    this.setState('disconnected');
  }
}

module.exports = { EngineSupervisor, defaultSocketPath, stateDir };
