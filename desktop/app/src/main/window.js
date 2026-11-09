// The one app window: a BaseWindow holding two WebContentsViews.
//  - site:  https://<server> in partition persist:onegy, filling the window.
//           The website is the app's only chrome (desktop/docs/site-bridge.md).
//  - panel: the native sync panel (app://ui), layered over the site and
//           hidden until the site's Sync entry, the tray or Ctrl+Shift+S opens it.
// No visible browser controls: back/forward, reload and zoom are keyboard and
// mouse-button only. A failed page load shows app://ui/offline.html.
'use strict';

const path = require('path');
const { app, BaseWindow, WebContentsView, nativeImage, session } = require('electron');
const { webPreferences, lockChromeView, lockSiteView, configureSiteSession, originOf } = require('./security');
const { UI_URL, OFFLINE_URL, handleScheme } = require('./protocol');
const { shortcutFor, nextZoom } = require('./shortcuts');

const SITE_PARTITION = 'persist:onegy';
const START_PATH = '/files';
const BACKGROUND = { 'frost-dark': '#08080a', frost: '#ffffff' };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NUDGE_DEBOUNCE_MS = 1500;
const PANEL_ONLY = new Set(['sync', 'devtools']);

function isMainFrameOf(frame, wc) {
  const main = wc && !wc.isDestroyed() ? wc.mainFrame : null;
  return Boolean(frame && main && !frame.parent
    && frame.processId === main.processId && frame.routingId === main.routingId);
}

class MainWindow {
  // opts: { settings (SettingsStore), serverOrigin(): string, onSiteMutation(), onSyncShortcut() }
  constructor(opts) {
    this.opts = opts;
    this.win = null;
    this.site = null;
    this.panel = null;
    this.siteUser = null; // username the current site page reported via the bridge
    this.nudgeTimer = null;
  }

  get background() {
    return BACKGROUND[this.opts.settings.get().theme] || BACKGROUND['frost-dark'];
  }

  create({ show }) {
    this.win = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'ONE.GY',
      backgroundColor: this.background,
      icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')),
      autoHideMenuBar: true,
    });
    this.win.on('resize', () => this.layout());
    // Mouse back/forward buttons (Windows and Linux).
    this.win.on('app-command', (_e, cmd) => {
      if (cmd === 'browser-backward') this.runShortcut('back');
      if (cmd === 'browser-forward') this.runShortcut('forward');
    });

    this.configureSiteSession();
    this.createSite();

    this.panel = new WebContentsView({
      webPreferences: webPreferences({ preload: path.join(__dirname, '..', 'preload', 'app-preload.js') }),
    });
    this.panel.setBackgroundColor(this.background);
    this.panel.setVisible(false);
    lockChromeView(this.panel.webContents);
    this.listenForShortcuts(this.panel.webContents, true);
    this.win.contentView.addChildView(this.panel);
    this.panel.webContents.loadURL(UI_URL);

    this.layout();
    if (show) this.show();
    return this.win;
  }

  // Once per run: app:// for the offline page, permissions, downloads, and the
  // change hook that nudges the engine after the user changes something on the website.
  configureSiteSession() {
    const ses = session.fromPartition(SITE_PARTITION);
    handleScheme(ses);
    configureSiteSession(ses, () => this.opts.serverOrigin());
    ses.webRequest.onCompleted({ urls: ['https://*/*'] }, (d) => {
      if (MUTATING.has(d.method) && d.statusCode < 400 && originOf(d.url) === this.opts.serverOrigin()) this.scheduleNudge();
    });
  }

  createSite() {
    const origin = this.opts.serverOrigin();
    this.site = new WebContentsView({
      webPreferences: webPreferences({
        partition: SITE_PARTITION,
        preload: path.join(__dirname, '..', 'preload', 'site-preload.js'),
        additionalArguments: [`--onegy-origin=${origin}`, `--onegy-version=${app.getVersion()}`],
      }),
    });
    this.site.setBackgroundColor(this.background);
    const wc = this.site.webContents;
    lockSiteView(wc, () => this.opts.serverOrigin());
    this.listenForShortcuts(wc, false);
    this.win.contentView.addChildView(this.site, 0);
    wc.on('page-title-updated', (_e, title) => this.win.setTitle(title || 'ONE.GY'));
    wc.on('did-navigate', () => {
      this.siteUser = null;
      wc.setZoomFactor(this.opts.settings.get().site_zoom);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.showOffline(url, desc);
    });
    wc.on('render-process-gone', (_e, details) => {
      console.error(`[WINDOW] site renderer gone: ${details.reason}`);
      this.showOffline(wc.getURL(), 'The page stopped working');
    });
    wc.loadURL(origin + START_PATH);
  }

  // A small local page with Retry instead of a blank window.
  showOffline(failedUrl, reason) {
    const origin = this.opts.serverOrigin();
    const retry = originOf(failedUrl) === origin ? failedUrl : origin + START_PATH;
    const q = new URLSearchParams({ url: retry, reason: String(reason || '').slice(0, 200), theme: this.opts.settings.get().theme });
    this.site.webContents.loadURL(`${OFFLINE_URL}?${q}`);
  }

  // Server URL changed: drop the old view (and its preload origin) and rebuild.
  recreateSite() {
    if (this.site) {
      this.win.contentView.removeChildView(this.site);
      this.site.webContents.close();
      this.site = null;
    }
    this.siteUser = null;
    this.createSite();
    this.layout();
  }

  scheduleNudge() {
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.opts.onSiteMutation(), NUDGE_DEBOUNCE_MS);
  }

  layout() {
    const { width, height } = this.win.getContentBounds();
    const bounds = { x: 0, y: 0, width, height };
    if (this.site) this.site.setBounds(bounds);
    if (this.panel) this.panel.setBounds(bounds);
  }

  listenForShortcuts(wc, isPanel) {
    wc.on('before-input-event', (e, input) => {
      const action = shortcutFor(input);
      if (!action || (isPanel && !PANEL_ONLY.has(action))) return;
      if (action === 'devtools' && app.isPackaged) return;
      e.preventDefault();
      this.runShortcut(action, isPanel ? wc : null);
    });
  }

  runShortcut(action, panelWc) {
    const wc = this.site.webContents;
    const nav = wc.navigationHistory;
    switch (action) {
      case 'back': if (!this.panelOpen && nav.canGoBack()) nav.goBack(); break;
      case 'forward': if (!this.panelOpen && nav.canGoForward()) nav.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'hardReload': wc.reloadIgnoringCache(); break;
      case 'zoomIn': this.zoom(1); break;
      case 'zoomOut': this.zoom(-1); break;
      case 'zoomReset': this.zoom(0); break;
      case 'sync': if (this.panelOpen) this.closePanel(); else this.opts.onSyncShortcut(); break;
      case 'devtools': (panelWc || wc).toggleDevTools(); break;
      default:
    }
  }

  zoom(dir) {
    const factor = nextZoom(this.opts.settings.get().site_zoom, dir);
    this.opts.settings.set({ site_zoom: factor });
    this.site.webContents.setZoomFactor(factor);
  }

  get panelOpen() {
    return Boolean(this.panel && this.panel.getVisible());
  }

  // Opens the sync panel over the site. username: the account the panel is
  // for (the site page's, else this computer's); the panel UI does the gating.
  openPanel({ username, screen }) {
    this.send({ type: 'app:panel', data: { username: username || null, screen: screen || 'syncs' } });
    this.panel.setVisible(true);
    this.show();
    this.panel.webContents.focus();
  }

  closePanel() {
    if (!this.panelOpen) return;
    this.panel.setVisible(false);
    this.site.webContents.focus();
  }

  // Load a path on the server in the site view (e.g. /account, /files/folder/12).
  openSitePath(pathname) {
    this.closePanel();
    this.site.webContents.loadURL(this.opts.serverOrigin() + pathname);
    this.show();
  }

  isSiteFrame(frame) {
    return Boolean(this.site && isMainFrameOf(frame, this.site.webContents)
      && originOf(frame.url) === this.opts.serverOrigin());
  }

  isPanelSender(wc) {
    return Boolean(this.panel && wc === this.panel.webContents);
  }

  // Engine and app events for the native panel.
  send(event) {
    if (this.panel && !this.panel.webContents.isDestroyed()) this.panel.webContents.send('onegy:event', event);
  }

  // Bridge status for the website (onStatus subscribers).
  sendSiteStatus(status) {
    if (this.site && !this.site.webContents.isDestroyed()) this.site.webContents.send('onegy:site-status', status);
  }

  setTheme() {
    const bg = this.background;
    this.win.setBackgroundColor(bg);
    this.site.setBackgroundColor(bg);
    this.panel.setBackgroundColor(bg);
  }

  show() {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }
}

module.exports = { MainWindow, isMainFrameOf, SITE_PARTITION };
