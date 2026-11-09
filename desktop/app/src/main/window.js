// The one app window: a BaseWindow holding two WebContentsViews.
//  - site:  https://<server> in partition persist:onegy, filling the window.
//           The website is the app's only chrome (desktop/docs/site-bridge.md).
//  - panel: the native sync panel (app://ui), layered over the site and
//           hidden until the site's Sync entry, the tray or Ctrl+Shift+S opens it.
// No visible browser controls: back/forward, reload and zoom are keyboard and
// mouse-button only. A failed page load shows app://ui/offline.html.
// The panel draws its own copy of the site's nav from the values the site
// preload reports (setSiteNav), follows the site's theme and zoom, and asks
// the site to switch theme or log out with the site's own controls.
'use strict';

const path = require('path');
const { app, BaseWindow, WebContentsView, nativeImage, session } = require('electron');
const { webPreferences, lockChromeView, lockSiteView, configureSiteSession, originOf } = require('./security');
const { UI_URL, OFFLINE_URL, handleScheme } = require('./protocol');
const { shortcutFor, nextZoom } = require('./shortcuts');
const { avatarDataUrl } = require('./site-nav');

const SITE_PARTITION = 'persist:onegy';
const START_PATH = '/files';
const BACKGROUND = { 'frost-dark': '#08080a', frost: '#ffffff' };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NUDGE_DEBOUNCE_MS = 1500;
const PANEL_ONLY = new Set(['sync', 'devtools']);
const PANEL_TITLE = 'Sync · ONE.GY';
// The panel says when it has rendered what it was opened with (panelReady);
// show it anyway after this long.
const PANEL_SHOW_FALLBACK_MS = 400;
// The panel fades out over the site's next page once its DOM is there
// (siteReady); fade anyway after this long.
const SITE_READY_MAX_MS = 2000;
const TRANSPARENT = '#00000000';

function isMainFrameOf(frame, wc) {
  const main = wc && !wc.isDestroyed() ? wc.mainFrame : null;
  return Boolean(frame && main && !frame.parent
    && frame.processId === main.processId && frame.routingId === main.routingId);
}

class MainWindow {
  // opts: { settings (SettingsStore), serverOrigin(): string, siteStatus(): object,
  //         onSiteMutation(), onSyncShortcut() }
  constructor(opts) {
    this.opts = opts;
    this.win = null;
    this.site = null;
    this.panel = null;
    this.siteUser = null; // username the current site page reported via the bridge
    this.siteNav = null; // the site's nav as values (site-nav.js), avatar as a data: URL
    this.navKey = '';
    this.avatar = { path: null, data: null };
    this.nudgeTimer = null;
    this.panelLoaded = false;
    this.panelWanted = false;
    this.pendingPanel = null;
    this.showTimer = null;
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
    // The panel paints its own background (ui/styles/app.css .dk-panel), so
    // it can fade in and out over the live site like the site's page switches.
    this.panel.setBackgroundColor(TRANSPARENT);
    this.panel.setVisible(false);
    lockChromeView(this.panel.webContents);
    this.listenForShortcuts(this.panel.webContents, true);
    this.win.contentView.addChildView(this.panel);
    this.panel.webContents.on('did-finish-load', () => {
      this.panelLoaded = true;
      this.panel.webContents.setZoomFactor(this.opts.settings.get().site_zoom);
      if (this.pendingPanel) this.send({ type: 'app:panel', data: this.pendingPanel });
      this.pendingPanel = null;
    });
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
    wc.on('page-title-updated', (_e, title) => { if (!this.panelOpen) this.win.setTitle(title || 'ONE.GY'); });
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
    this.siteNav = null;
    this.navKey = '';
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
      case 'sync': if (this.panelOpen) this.send({ type: 'app:navigate', data: { screen: 'close' } }); else this.opts.onSyncShortcut(); break;
      case 'devtools': (panelWc || wc).toggleDevTools(); break;
      default:
    }
  }

  zoom(dir) {
    const factor = nextZoom(this.opts.settings.get().site_zoom, dir);
    this.opts.settings.set({ site_zoom: factor });
    this.site.webContents.setZoomFactor(factor);
    this.panel.webContents.setZoomFactor(factor);
  }

  get panelOpen() {
    return Boolean(this.panel && this.panel.getVisible());
  }

  // Opens the sync panel over the site. username: the account the panel is
  // for (the site page's, else this computer's); the panel UI does the gating.
  // It becomes visible once it has rendered (showPanel), so it never flashes
  // a stale screen or theme.
  openPanel({ username, screen }) {
    const data = {
      username: username || null,
      screen: screen || 'syncs',
      theme: this.opts.settings.get().theme,
      nav: this.siteNav,
      status: this.opts.siteStatus(),
    };
    this.panelWanted = true;
    if (this.panelLoaded) this.send({ type: 'app:panel', data });
    else this.pendingPanel = data;
    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => this.showPanel(), PANEL_SHOW_FALLBACK_MS);
    this.show();
  }

  showPanel() {
    clearTimeout(this.showTimer);
    if (!this.panelWanted) return;
    if (!this.panelOpen) {
      this.panel.setVisible(true);
      this.win.setTitle(PANEL_TITLE);
    }
    this.panel.webContents.focus();
  }

  // Hides the panel at once; the panel UI calls it when it has faded out.
  closePanel() {
    this.panelWanted = false;
    clearTimeout(this.showTimer);
    if (!this.panelOpen) return;
    this.panel.setVisible(false);
    this.win.setTitle(this.site.webContents.getTitle() || 'ONE.GY');
    this.site.webContents.focus();
  }

  // nav: cleaned by site-nav.js. The avatar path is fetched with the site's
  // session once per path and handed to the panel as a data: URL.
  async setSiteNav(nav) {
    const key = JSON.stringify(nav);
    if (key === this.navKey) return;
    this.navKey = key;
    if (nav.avatar !== this.avatar.path) {
      const data = nav.avatar
        ? await avatarDataUrl((url, init) => this.site.webContents.session.fetch(url, init), this.opts.serverOrigin() + nav.avatar).catch(() => null)
        : null;
      this.avatar = { path: nav.avatar, data };
    }
    if (key !== this.navKey) return; // a newer nav arrived meanwhile
    this.siteNav = { ...nav, avatar: this.avatar.data };
    this.send({ type: 'app:nav', data: this.siteNav });
  }

  // The site's own theme option (theme-switch.js persists it); the panel then
  // follows the theme the site reports. No site page to ask: set it directly.
  setSiteTheme(theme) {
    if (originOf(this.site.webContents.getURL()) === this.opts.serverOrigin()) this.site.webContents.send('onegy:site-theme', theme);
    else this.opts.settings.set({ theme });
  }

  // Submits the site's own logout form; resolves once the page it lands on
  // is there for the panel to fade out over.
  siteLogout() {
    const ready = this.siteReady();
    this.site.webContents.send('onegy:site-logout');
    return ready;
  }

  // Load a path on the server in the site view (e.g. /account, /files/folder/12)
  // under the panel; resolves once the page is there for the panel to fade out over.
  openSitePath(pathname) {
    const ready = this.siteReady();
    this.site.webContents.loadURL(this.opts.serverOrigin() + pathname);
    this.show();
    return ready;
  }

  // Resolves on the site's next dom-ready, or after SITE_READY_MAX_MS.
  siteReady() {
    const wc = this.site.webContents;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        wc.off('dom-ready', done);
        resolve();
      };
      const timer = setTimeout(done, SITE_READY_MAX_MS);
      wc.on('dom-ready', done);
    });
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
  }

  show() {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }
}

module.exports = { MainWindow, isMainFrameOf, SITE_PARTITION };
