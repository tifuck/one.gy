// Dev-only browser bridge: runs the native UI (src/ui) in a normal browser
// against the REAL engine, for end-to-end tests where Electron cannot open a
// window. Node stdlib plus the app's own pure-Node main modules (engine
// supervisor, settings store, removeSync, method whitelist). Never packaged
// (electron-builder only ships src/ and package.json).
//
//   node dev/browser-bridge.js --engine ../engine/bin/onegy-engine \
//     --state-dir /tmp/x/state --socket /tmp/x/engine.sock [--port 0] [--engine-arg=--insecure-tls]
//
// HTTP on 127.0.0.1 only:
//   GET  /...            files of src/ui (index.html at /)
//   GET  /bridge.js      dev/bridge-client.js: maps window.onegy onto this server
//   POST /rpc            {method, params} -> engine (same whitelist as the app)
//   POST /app/<name>     {args} -> app-owned actions (preload names)
//   GET  /events         server-sent events: engine events + app:engine/app:settings/app:panel/
//                        app:siteStatus
//   POST /panel          {username, screen, nav}: what the site's openSync() does (opens the
//                        panel); nav is the site nav data (main/site-nav.js shape)
//   GET  /site-status?username=  what the site's onStatus() gets (main/sync-status.js)
//   GET|POST /stub       read the action log / set {pickFolder, pickFiles} answers
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EngineSupervisor } = require('../src/main/engine');
const { SettingsStore } = require('../src/main/settings-store');
const { removeSync } = require('../src/main/remove-sync');
const { UI_METHODS, SLOW_METHODS, SLOW_TIMEOUT_MS } = require('../src/main/ui-methods');
const { SyncStatus } = require('../src/main/sync-status');
const { cleanNav } = require('../src/main/site-nav');

const UI_DIR = path.join(__dirname, '..', 'src', 'ui');
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

function args() {
  const out = { port: 0, engineArgs: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--engine-arg=')) out.engineArgs.push(a.slice('--engine-arg='.length));
    else if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  for (const k of ['engine', 'stateDir', 'socket']) if (!out[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  return out;
}

const opt = args();
const clients = new Set();
const log = [];
const stubs = { pickFolder: null, pickFiles: [] };
const trashDir = path.join(path.dirname(opt.stateDir), 'trash');
const settings = new SettingsStore(path.join(path.dirname(opt.stateDir), 'app'));

function broadcast(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}

const engine = new EngineSupervisor({
  command: path.resolve(opt.engine),
  args: ['--state-dir', opt.stateDir, ...opt.engineArgs],
  socketPath: opt.socket,
});
const sync = new SyncStatus(engine);
let siteUser = null; // the last /panel username, like window.siteUser in the app
sync.on('change', () => broadcast({ type: 'app:siteStatus', data: sync.forUser(siteUser) }));
engine.on('state', (state) => broadcast({ type: 'app:engine', data: { state } }));
engine.on('event', broadcast);
settings.onChange((next) => broadcast({ type: 'app:settings', data: next }));

// App-owned actions; names match the preload (window.onegy).
const APP = {
  engineState: () => engine.state,
  version: () => ({ app: '0.0.0-bridge', electron: 'browser', platform: process.platform, hostname: os.hostname().slice(0, 80) }),
  'appSettings.get': () => settings.get(),
  'appSettings.set': (patch) => {
    const { settings: next, errors } = settings.set(patch);
    if (errors.length) throw Object.assign(new Error(errors.join(', ')), { code: 'validation_failed' });
    return next;
  },
  probeServer: (url) => ({ ok: true, origin: url, message: 'Server supports desktop sync.' }),
  pickFolder: () => stubs.pickFolder,
  pickFiles: () => stubs.pickFiles,
  openPath: (p) => { log.push(['openPath', p]); return true; },
  openExternal: (u) => { log.push(['openExternal', u]); return true; },
  openSite: (p) => { log.push(['openSite', p]); return true; },
  closePanel: () => { log.push(['closePanel']); return true; },
  panelReady: () => true,
  // The site would click its own theme option and report the theme back.
  siteTheme: (theme) => { log.push(['siteTheme', theme]); settings.set({ theme }); return true; },
  siteLogout: () => { log.push(['siteLogout']); return true; },
  exportDiagnostics: () => engine.call('diagnostics.export', { path: path.join(path.dirname(opt.stateDir), 'diagnostics.zip') }, { timeoutMs: SLOW_TIMEOUT_MS }),
  openDataFolder: () => true,
  removeSync: (id, o) => removeSync({
    engine: { call: (m, p) => engine.call(m, p, { timeoutMs: SLOW_TIMEOUT_MS }) },
    // Stand-in for shell.trashItem: move into <test dir>/trash.
    trash: async (p) => {
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(p, path.join(trashDir, `${path.basename(p)}-${Date.now()}`));
      log.push(['trash', p]);
    },
  }, id, o || {}),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (err) { reject(err); }
    });
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const envelope = async (res, fn) => {
  try {
    json(res, 200, { ok: true, result: (await fn()) ?? null });
  } catch (err) {
    json(res, 200, { ok: false, error: { code: err.code || 'internal', message: err.message, data: err.data || null } });
  }
};

function serveFile(res, rel) {
  const file = path.resolve(UI_DIR, `.${rel === '/' ? '/index.html' : rel}`);
  if (!file.startsWith(UI_DIR + path.sep)) return json(res, 404, {});
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, {});
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'app:engine', data: { state: engine.state } })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/bridge.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(fs.readFileSync(path.join(__dirname, 'bridge-client.js')));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/panel') {
      const { username, screen, nav } = await readBody(req);
      siteUser = username || null;
      broadcast({
        type: 'app:panel',
        data: {
          username: siteUser, screen: screen || 'syncs', theme: settings.get().theme, nav: cleanNav(nav), status: sync.forUser(siteUser),
        },
      });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/site-status') {
      return json(res, 200, sync.forUser(url.searchParams.get('username')));
    }
    if (url.pathname === '/stub') {
      if (req.method === 'POST') Object.assign(stubs, await readBody(req));
      return json(res, 200, { stubs, log });
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const { method, params } = await readBody(req);
      return envelope(res, () => {
        if (!UI_METHODS.has(method)) throw Object.assign(new Error(`Unknown method ${method}`), { code: 'forbidden' });
        return engine.call(method, params, SLOW_METHODS.has(method) ? { timeoutMs: SLOW_TIMEOUT_MS } : undefined);
      });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/app/')) {
      const fn = APP[url.pathname.slice(5)];
      const body = await readBody(req);
      return envelope(res, () => {
        if (!fn) throw Object.assign(new Error('Unknown action'), { code: 'forbidden' });
        return fn(...(Array.isArray(body.args) ? body.args : []));
      });
    }
    if (req.method === 'GET') return serveFile(res, decodeURIComponent(url.pathname));
    json(res, 404, {});
  } catch (err) {
    json(res, 400, { error: err.message });
  }
});

server.listen(Number(opt.port) || 0, '127.0.0.1', () => {
  console.log(`[BRIDGE] http://127.0.0.1:${server.address().port}/`);
  engine.start();
});

const stop = () => engine.stop().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
