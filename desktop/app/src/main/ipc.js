// ipcMain handlers. The native panel may call a fixed list of engine methods
// plus a few app-owned actions; the website gets the site bridge
// (desktop/docs/site-bridge.md): unlock key, open the sync panel, sync status,
// its theme and its nav. Every handler checks who is asking and validates
// what it gets.
'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { app, dialog, ipcMain, net, shell } = require('electron');
const { openExternal, isWebUrl } = require('./security');
const { isMainFrameOf } = require('./window');
const { normalizeServerUrl } = require('./settings-store');
const { isUiUrl } = require('./protocol');
const { removeSync } = require('./remove-sync');
const { cleanNav, isSitePath } = require('./site-nav');
const { UI_METHODS, SLOW_METHODS, SLOW_TIMEOUT_MS } = require('./ui-methods');

const MAX_PARAMS_BYTES = 1024 * 1024;
const PANEL_SCREENS = new Set(['syncs', 'transfers', 'issues', 'settings']);
const THEMES = new Set(['frost', 'frost-dark']);
// Server usernames: 1-80 characters (User.username).
const isUsername = (v) => typeof v === 'string' && v.length > 0 && v.length <= 80 && !/[\u0000-\u001f]/.test(v);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;

function errorEnvelope(err) {
  return { ok: false, error: { code: err.code || 'internal', message: err.message || 'Something went wrong', data: err.data || null } };
}

async function probeServer(raw) {
  const origin = normalizeServerUrl(raw);
  if (!origin) return { ok: false, origin: null, message: 'Enter an https:// address.' };
  try {
    const res = await net.fetch(`${origin}/apiv1/sync/capabilities`, { method: 'GET', redirect: 'error', cache: 'no-store' });
    const body = await res.json().catch(() => null);
    const code = body && body.code;
    if (res.ok || (res.status === 401 && (code === 'invalid_token' || code === 'not_authenticated'))) return { ok: true, origin, message: 'Server supports desktop sync.' };
    if (res.status === 403 && code === 'sync_disabled') return { ok: false, origin, message: 'Desktop sync is turned off on this server.' };
    return { ok: false, origin, message: `This server does not support desktop sync (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, origin, message: `Could not reach the server: ${err.message}` };
  }
}

// deps: { window (MainWindow), engine (EngineSupervisor), settings (SettingsStore),
//         sync (SyncStatus) }
function registerIpc({ window, engine, settings, sync }) {
  const fromChrome = (event) => window.isPanelSender(event.sender)
    && isMainFrameOf(event.senderFrame, event.sender)
    && isUiUrl(event.senderFrame.url);

  // Registers a handler that only the native UI may call.
  const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
    if (!fromChrome(event)) {
      console.error(`[IPC] refused ${channel} from an unexpected sender`);
      return errorEnvelope({ code: 'forbidden', message: 'Not allowed' });
    }
    try {
      return { ok: true, result: await fn(...args) };
    } catch (err) {
      return errorEnvelope(err);
    }
  });
  const parentWindow = () => window.win;

  handle('engine:call', (method, params) => {
    if (typeof method !== 'string' || !UI_METHODS.has(method)) throw Object.assign(new Error(`Unknown method ${method}`), { code: 'forbidden' });
    if (params !== undefined && !isPlainObject(params)) throw Object.assign(new Error('params must be an object'), { code: 'validation_failed' });
    if (params !== undefined && JSON.stringify(params).length > MAX_PARAMS_BYTES) throw Object.assign(new Error('params too large'), { code: 'validation_failed' });
    return engine.call(method, params, SLOW_METHODS.has(method) ? { timeoutMs: SLOW_TIMEOUT_MS } : undefined);
  });
  handle('engine:state', () => engine.state);

  handle('app:version', () => ({
    app: app.getVersion(), electron: process.versions.electron, platform: process.platform, hostname: os.hostname().slice(0, 80),
  }));
  handle('app:settings:get', () => settings.get());
  handle('app:settings:set', (patch) => {
    const { settings: next, errors } = settings.set(patch);
    if (errors.length) throw Object.assign(new Error(errors.join(', ')), { code: 'validation_failed', data: { errors } });
    return next;
  });
  handle('app:probeServer', (url) => probeServer(url));

  handle('app:pickFolder', async (opts) => {
    const o = isPlainObject(opts) ? opts : {};
    const res = await dialog.showOpenDialog(parentWindow(), {
      title: typeof o.title === 'string' ? o.title.slice(0, 120) : 'Choose a folder',
      defaultPath: typeof o.defaultPath === 'string' ? o.defaultPath : app.getPath('home'),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate', 'dontAddToRecent'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('app:pickFiles', async () => {
    const res = await dialog.showOpenDialog(parentWindow(), {
      title: 'Choose files to upload',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // Folders open in the file manager; files are only revealed, never executed.
  handle('app:openPath', async (p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw Object.assign(new Error('Not an absolute path'), { code: 'validation_failed' });
    const st = await fs.stat(p).catch(() => null);
    if (st && st.isDirectory()) {
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    } else {
      shell.showItemInFolder(p);
    }
    return true;
  });
  handle('app:openExternal', (url) => {
    if (!isWebUrl(url)) throw Object.assign(new Error('Only web links can be opened'), { code: 'validation_failed' });
    openExternal(url);
    return true;
  });
  handle('app:openSite', (pathname) => {
    if (!isSitePath(pathname)) throw Object.assign(new Error('Invalid path'), { code: 'validation_failed' });
    window.openSitePath(pathname);
    return true;
  });
  handle('app:closePanel', () => {
    window.closePanel();
    return true;
  });
  handle('app:panelReady', () => {
    window.showPanel();
    return true;
  });
  handle('app:siteTheme', (theme) => {
    if (!THEMES.has(theme)) throw Object.assign(new Error('Unknown theme'), { code: 'validation_failed' });
    window.setSiteTheme(theme);
    return true;
  });
  handle('app:siteLogout', () => {
    window.siteLogout();
    return true;
  });
  handle('app:exportDiagnostics', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(parentWindow(), {
      title: 'Export diagnostics',
      defaultPath: path.join(app.getPath('downloads'), `onegy-diagnostics-${stamp}.zip`),
    });
    if (res.canceled || !res.filePath) return null;
    return engine.call('diagnostics.export', { path: res.filePath }, { timeoutMs: SLOW_TIMEOUT_MS });
  });
  handle('app:removeSync', (id, opts) => removeSync(
    { engine: { call: (m, p) => engine.call(m, p, { timeoutMs: SLOW_TIMEOUT_MS }) }, trash: (p) => shell.trashItem(p) },
    id, isPlainObject(opts) ? opts : {},
  ));
  handle('app:openDataFolder', async () => {
    const info = await engine.call('engine.info');
    if (info && typeof info.state_dir === 'string' && path.isAbsolute(info.state_dir)) await shell.openPath(info.state_dir);
    return true;
  });

  // Website bridge: only the site view's main frame on the configured origin.
  ipcMain.on('site:openSync', (event, opts) => {
    if (!window.isSiteFrame(event.senderFrame)) return;
    const o = isPlainObject(opts) ? opts : {};
    if (!isUsername(o.username)) return;
    window.siteUser = o.username;
    window.openPanel({ username: o.username, screen: PANEL_SCREENS.has(o.screen) ? o.screen : 'syncs' });
  });
  ipcMain.handle('site:status', (event, username) => {
    if (!window.isSiteFrame(event.senderFrame)) return null;
    if (isUsername(username)) window.siteUser = username;
    return sync.forUser(window.siteUser);
  });
  ipcMain.on('site:theme', (event, theme) => {
    if (window.isSiteFrame(event.senderFrame) && THEMES.has(theme) && settings.get().theme !== theme) settings.set({ theme });
  });
  ipcMain.on('site:nav', (event, raw) => {
    if (!window.isSiteFrame(event.senderFrame)) return;
    const nav = cleanNav(raw);
    if (nav) window.setSiteNav(nav).catch((err) => console.error(`[IPC] site nav: ${err.message}`));
  });
  ipcMain.handle('site:unlock', async (event) => {
    if (!window.isSiteFrame(event.senderFrame)) return null;
    try {
      const res = await engine.call('account.webUnlockKey');
      return res && typeof res.master_key_b64 === 'string' ? res.master_key_b64 : null;
    } catch {
      return null;
    }
  });
}

module.exports = { registerIpc, UI_METHODS, probeServer };
