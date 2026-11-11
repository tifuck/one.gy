// ipcMain handlers. The native panel may call a fixed list of engine methods
// plus a few app-owned actions; the title bar sends history commands and its
// colours; the update toast its action and height; the website gets the site
// bridge (desktop/docs/site-bridge.md): unlock key, open the sync panel, sync
// status, its theme, its rail width and its sign-out; the tray popover reads
// a few engine methods and asks for the tray's actions. Every handler checks
// who is asking and validates what it gets.
'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { app, dialog, ipcMain, net, shell } = require('electron');
const { openExternal, isWebUrl } = require('./security');
const { isMainFrameOf, SETTINGS_SCREENS } = require('./window');
const { normalizeServerUrl } = require('./settings-store');
const { isUiUrl } = require('./protocol');
const { removeSync } = require('./remove-sync');
const { cleanInset, isSitePath } = require('./site-nav');
const {
  UI_METHODS, POPOVER_METHODS, SLOW_METHODS, SLOW_TIMEOUT_MS,
} = require('./ui-methods');
const { mayUnlock } = require('./sync-status');

const MAX_PARAMS_BYTES = 1024 * 1024;
const PANEL_SCREENS = new Set(['syncs', 'transfers', 'issues', 'settings', ...SETTINGS_SCREENS]);
// Calls that can remove a sync (the engine sends no event for a removal).
const REMOVES_SYNCS = new Set(['syncs.remove', 'issues.resolve']);
const THEMES = new Set(['frost', 'frost-dark']);
const TITLEBAR_COMMANDS = new Set(['back', 'forward', 'reload']);
// What getComputedStyle reports for a colour.
const isCssColor = (v) => typeof v === 'string' && /^rgba?\([\d.,\s]{5,40}\)$/.test(v);
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
//         sync (SyncStatus), updater (updater.js), lockNow(), signOut(): 'site' | 'done' | 'cancelled',
//         popover (TrayPopover) }
function registerIpc({
  window, engine, settings, sync, updater, lockNow, signOut, popover,
}) {
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
    const call = engine.call(method, params, SLOW_METHODS.has(method) ? { timeoutMs: SLOW_TIMEOUT_MS } : undefined);
    if (REMOVES_SYNCS.has(method)) call.finally(() => sync.loadSyncs()).catch(() => {});
    return call;
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
  // Resolves once the page is there (the panel then fades out over it).
  handle('app:openSite', async (pathname) => {
    if (!isSitePath(pathname)) throw Object.assign(new Error('Invalid path'), { code: 'validation_failed' });
    await window.openSitePath(pathname);
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
  handle('app:lockNow', () => {
    lockNow();
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
  ).finally(() => sync.loadSyncs()));
  handle('app:update:state', () => updater.state());
  handle('app:update:check', () => updater.check());
  // Installs (and restarts) in the background; state arrives as app:update events.
  handle('app:update:install', () => {
    if (window.panelOpen) window.panelScreen = 'updates';
    updater.install();
    return updater.state();
  });
  handle('app:openDataFolder', async () => {
    const info = await engine.call('engine.info');
    if (info && typeof info.state_dir === 'string' && path.isAbsolute(info.state_dir)) await shell.openPath(info.state_dir);
    return true;
  });

  // Title bar: only its own view.
  ipcMain.on('titlebar:command', (event, name) => {
    if (window.isTitlebarSender(event.sender) && isMainFrameOf(event.senderFrame, event.sender) && TITLEBAR_COMMANDS.has(name)) {
      window.runShortcut(name);
    }
  });
  ipcMain.on('titlebar:colors', (event, c) => {
    if (!window.isTitlebarSender(event.sender) || !isPlainObject(c) || !isCssColor(c.color) || !isCssColor(c.symbolColor)) return;
    window.setTitlebarColors(c.color, c.symbolColor);
  });

  // Update toast: only its own view.
  const fromNotice = (event) => window.isNoticeSender(event.sender) && isMainFrameOf(event.senderFrame, event.sender) && isUiUrl(event.senderFrame.url);
  ipcMain.on('update:install', (event) => {
    if (fromNotice(event)) updater.install();
  });
  ipcMain.on('update:size', (event, px) => {
    if (fromNotice(event) && Number.isFinite(px) && px >= 0 && px <= 600) window.setNoticeHeight(Math.ceil(px));
  });

  // Tray popover: only its own window.
  const fromPopover = (event) => popover.isSender(event.sender) && isMainFrameOf(event.senderFrame, event.sender) && isUiUrl(event.senderFrame.url);
  ipcMain.handle('popover:engine', async (event, method, params) => {
    if (!fromPopover(event) || !POPOVER_METHODS.has(method) || (params !== undefined && !isPlainObject(params))) {
      return errorEnvelope({ code: 'forbidden', message: 'Not allowed' });
    }
    try {
      return { ok: true, result: await engine.call(method, params) };
    } catch (err) {
      return errorEnvelope(err);
    }
  });
  ipcMain.on('popover:action', (event, name, arg) => {
    if (fromPopover(event)) popover.run(name, arg);
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
  ipcMain.handle('site:syncs', (event, username) => {
    if (!window.isSiteFrame(event.senderFrame)) return [];
    if (isUsername(username)) window.siteUser = username;
    return sync.syncsForUser(window.siteUser);
  });
  ipcMain.on('site:theme', (event, theme) => {
    if (window.isSiteFrame(event.senderFrame) && THEMES.has(theme) && settings.get().theme !== theme) settings.set({ theme });
  });
  ipcMain.on('site:inset', (event, px) => {
    const inset = cleanInset(px);
    if (window.isSiteFrame(event.senderFrame) && inset !== null) window.setSiteInset(inset);
  });
  ipcMain.on('site:leavePanel', (event, opts) => {
    if (window.isSiteFrame(event.senderFrame)) window.leavePanel(Boolean(opts && opts.now));
  });
  ipcMain.handle('site:logout', async (event) => {
    if (!window.isSiteFrame(event.senderFrame)) return 'cancelled';
    return signOut();
  });
  ipcMain.handle('site:unlock', async (event, username) => {
    if (!window.isSiteFrame(event.senderFrame) || !isUsername(username)) return null;
    try {
      const account = await engine.call('account.status');
      if (!mayUnlock(account, username)) return null;
      // The page's account as the server sees it (the page's own DOM is not proof).
      const who = await window.site.webContents.session.fetch(`${settings.get().server_url}/desktop/whoami`, {
        headers: { 'X-Requested-With': 'XMLHttpRequest' }, cache: 'no-store', redirect: 'error',
      });
      const me = who.ok ? await who.json() : null;
      if (!me || me.user_id !== account.user_id) return null;
      const res = await engine.call('account.webUnlockKey');
      return res && typeof res.master_key_b64 === 'string' ? res.master_key_b64 : null;
    } catch {
      return null;
    }
  });
}

module.exports = { registerIpc, UI_METHODS, probeServer };
