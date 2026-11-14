// Electron hardening (plan 11.3): web preferences for every view, navigation
// locks, window.open policy, permissions, certificate errors and downloads.
'use strict';

const path = require('path');
const { app, shell, Notification } = require('electron');
const { isUiUrl } = require('./protocol');

// Permissions the website may get, and only from the configured server origin.
const SITE_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write', 'media', 'fullscreen']);

function webPreferences(extra) {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    ...extra,
  };
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function isWebUrl(url) {
  try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; }
}

function openExternal(url) {
  if (isWebUrl(url)) shell.openExternal(url).catch((err) => console.error(`[SECURITY] openExternal failed: ${err.message}`));
}

// App-wide rules; call once before any window exists.
function hardenApp() {
  app.enableSandbox();
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
  });
  // Never bypass TLS errors, not even for self-hosted servers.
  app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
    console.error(`[SECURITY] certificate error for ${originOf(url)}: ${error}`);
    callback(false);
  });
}

// The native UI view: only app://ui pages, no permissions at all.
function lockChromeView(wc) {
  const guard = (e) => {
    if (isUiUrl(e.url)) return;
    e.preventDefault();
    openExternal(e.url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  wc.session.setPermissionCheckHandler(() => false);
}

// The website view. getOrigin() returns the configured server origin.
function lockSiteView(wc, getOrigin) {
  const guard = (e) => {
    if (originOf(e.url) === getOrigin()) return;
    e.preventDefault();
    openExternal(e.url);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', (e) => { if (e.isMainFrame) guard(e); });
  wc.setWindowOpenHandler(({ url }) => {
    if (originOf(url) === getOrigin()) wc.loadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });
}

function configureSiteSession(ses, getOrigin) {
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(SITE_PERMISSIONS.has(permission) && originOf(details.requestingUrl) === getOrigin());
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => (
    SITE_PERMISSIONS.has(permission) && requestingOrigin === getOrigin()
  ));
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({
      title: 'Save download',
      defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename() || 'download')),
    });
    // There is no download bar: say when one fails ('cancelled' is the user's choice).
    item.once('done', (_ev, state) => {
      if (state !== 'interrupted') return;
      console.error(`[DOWNLOAD] ${item.getFilename()} was interrupted`);
      if (Notification.isSupported()) new Notification({ title: 'Download failed', body: `${item.getFilename()} could not be downloaded. Try again.` }).show();
    });
  });
}

module.exports = { webPreferences, hardenApp, lockChromeView, lockSiteView, configureSiteSession, openExternal, originOf, isWebUrl };
