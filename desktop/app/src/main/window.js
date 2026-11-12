// The one app window: a BaseWindow (hidden native title bar, native window
// controls as the title bar overlay) holding three WebContentsViews.
//  - titlebar: app://ui/titlebar.html across the top: drag area, back /
//           forward / reload and the window title.
//  - site:  https://<server> in partition persist:onegy, below the title bar.
//           The site renders its desktop shell for this app (User-Agent token,
//           desktop/docs/site-bridge.md): its rail is the app's navigation.
//  - panel: the native sync panel (app://ui) over the site's content area
//           (right of the rail the site reports, setSiteInset), hidden until
//           the rail's Sync entry, the tray or Ctrl+Shift+S opens it.
//  - notice: app://ui/update.html, the update toast in the bottom right
//           corner over everything, sized to the card it shows (setNoticeHeight).
// History and zoom also have keys and mouse buttons. A failed page load shows
// app://ui/offline.html. The panel follows the site's theme and zoom and
// closes when a link in the site's rail opens another page.
'use strict';

const path = require('path');
const { app, BaseWindow, WebContentsView, nativeImage, session } = require('electron');
const { webPreferences, lockChromeView, lockSiteView, configureSiteSession, originOf } = require('./security');
const {
  UI_URL, OFFLINE_URL, TITLEBAR_URL, UPDATE_URL, handleScheme,
} = require('./protocol');
const { shortcutFor, nextZoom } = require('./shortcuts');

const SITE_PARTITION = 'persist:onegy';
const START_PATH = '/files';
const BACKGROUND = { 'frost-dark': '#08080a', frost: '#ffffff' };
// Title bar height (DIP) and its colours per theme until the bar reports the
// ones it painted (site --pane / --text-dim, titlebar.js).
const TITLEBAR_H = 36;
const TITLEBAR_COLORS = { 'frost-dark': ['#0e0e11', '#96969e'], frost: ['#f6f7f9', '#5f6873'] };
// The site renders its desktop shell for this token (src/app/225_desktop_pages.py).
const UA_TOKEN = 'ONEGY-Desktop';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NUDGE_DEBOUNCE_MS = 1500;
const PANEL_ONLY = new Set(['sync', 'devtools']);
// The panel says when it has rendered what it was opened with (panelReady);
// show it anyway after this long.
const PANEL_SHOW_FALLBACK_MS = 400;
// The panel's App settings sections (the rest is the sync panel: syncs,
// transfers, issues, settings = sync settings).
const SETTINGS_SCREENS = new Set(['general', 'account', 'security', 'updates', 'about']);
// The panel fades out over the site's next page once its DOM is there
// (siteReady); fade anyway after this long.
const SITE_READY_MAX_MS = 2000;
const TRANSPARENT = '#00000000';
// The update toast view's width (DIP), shadow room included (styles/update.css).
const NOTICE_W = 380;
// Main-frame HTTP statuses only the server's proxy sends, while the server is
// down (503 is the server's own "busy", with its own page).
const GATEWAY_ERRORS = new Set([502, 504]);

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
    this.titlebar = null;
    this.siteUser = null; // username the current site page reported via the bridge
    this.siteInset = 0; // the site's rail width in CSS px (site:inset); the panel starts right of it
    this.siteTitle = 'ONE.GY';
    this.siteWanted = null; // last main-frame URL the site view set out to load
    this.nudgeTimer = null;
    this.panelLoaded = false;
    this.panelWanted = false;
    this.pendingPanel = null;
    this.showTimer = null;
    this.siteLocked = false; // app locked: no site page, the panel cannot be closed
    this.panelScreen = null; // the screen the panel was last opened with
    this.notice = null;
    this.noticeHeight = 0;
    this.update = null; // the updater's state, for the toast
    this.resumePath = null; // the site path to open first after an update restart
    this.offlineRetries = 0; // offline pages in a row, for their retry backoff
    this.maximizeOnShow = false;
  }

  get theme() {
    return this.opts.settings.get().theme === 'frost' ? 'frost' : 'frost-dark';
  }

  get background() {
    return BACKGROUND[this.theme];
  }

  // One DIP short of the bar so its bottom hairline runs under the controls too.
  overlay(colors = TITLEBAR_COLORS[this.theme]) {
    return { color: colors[0], symbolColor: colors[1], height: TITLEBAR_H - 1 };
  }

  // bounds / maximized: where the window was before an update restart.
  create({
    show, loadSite = true, bounds = null, maximized = false,
  }) {
    this.win = new BaseWindow({
      width: 1280,
      height: 820,
      ...bounds,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'ONE.GY',
      backgroundColor: this.background,
      icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')),
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: this.overlay(),
    });
    this.win.on('resize', () => this.layout());
    // Mouse back/forward buttons (Windows and Linux).
    this.win.on('app-command', (_e, cmd) => {
      if (cmd === 'browser-backward') this.runShortcut('back');
      if (cmd === 'browser-forward') this.runShortcut('forward');
    });

    this.configureSiteSession();
    this.titlebar = new WebContentsView({
      webPreferences: webPreferences({ preload: path.join(__dirname, '..', 'preload', 'titlebar-preload.js') }),
    });
    this.titlebar.setBackgroundColor(TITLEBAR_COLORS[this.theme][0]);
    lockChromeView(this.titlebar.webContents);
    this.listenForShortcuts(this.titlebar.webContents, false);
    this.win.contentView.addChildView(this.titlebar);
    this.titlebar.webContents.on('did-finish-load', () => this.sendTitlebar());
    this.titlebar.webContents.loadURL(TITLEBAR_URL);

    this.siteLocked = !loadSite;
    this.createSite(loadSite);

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
    // The panel titles itself by screen (app.js), e.g. "Sign in".
    this.panel.webContents.on('page-title-updated', () => this.sendTitlebar());
    this.panel.webContents.on('did-finish-load', () => {
      this.panelLoaded = true;
      this.panel.webContents.setZoomFactor(this.opts.settings.get().site_zoom);
      if (this.pendingPanel) this.send({ type: 'app:panel', data: this.pendingPanel });
      this.pendingPanel = null;
    });
    this.panel.webContents.loadURL(UI_URL);

    this.notice = new WebContentsView({
      webPreferences: webPreferences({ preload: path.join(__dirname, '..', 'preload', 'update-preload.js') }),
    });
    this.notice.setBackgroundColor(TRANSPARENT);
    this.notice.setVisible(false);
    lockChromeView(this.notice.webContents);
    this.win.contentView.addChildView(this.notice);
    this.notice.webContents.on('did-finish-load', () => this.sendUpdate());
    this.notice.webContents.loadURL(UPDATE_URL);

    this.layout();
    this.maximizeOnShow = maximized;
    if (show) this.show();
    return this.win;
  }

  // Once per run: app:// for the offline page, permissions, downloads, and the
  // change hook that nudges the engine after the user changes something on the website.
  configureSiteSession() {
    const ses = session.fromPartition(SITE_PARTITION);
    handleScheme(ses);
    configureSiteSession(ses, () => this.opts.serverOrigin());
    ses.setUserAgent(`${ses.getUserAgent()} ${UA_TOKEN}/${app.getVersion()}`);
    ses.webRequest.onCompleted({ urls: ['https://*/*'] }, (d) => {
      if (MUTATING.has(d.method) && d.statusCode < 400 && originOf(d.url) === this.opts.serverOrigin()) this.scheduleNudge();
    });
  }

  // load false: an empty view (app locked).
  createSite(load = true) {
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
    wc.on('page-title-updated', (_e, title) => {
      this.siteTitle = title || 'ONE.GY';
      this.sendTitlebar();
    });
    // The page asked for, before redirects (the sign-in page drops it).
    wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) this.siteWanted = d.url; });
    wc.on('did-navigate', (_e, url, code) => {
      // A gateway error (the server restarting for an update): the offline
      // page, which tries again by itself.
      if (GATEWAY_ERRORS.has(code) && originOf(url) === this.opts.serverOrigin()) {
        this.showOffline(url, `HTTP ${code}`);
        return;
      }
      if (originOf(url) === this.opts.serverOrigin()) this.offlineRetries = 0;
      this.siteUser = null;
      wc.setZoomFactor(this.opts.settings.get().site_zoom);
      this.sendTitlebar();
      if (this.opts.onSiteNavigate) this.opts.onSiteNavigate(url, this.siteWanted);
    });
    wc.on('did-navigate-in-page', () => this.sendTitlebar());
    // A page that loads under the open panel (crypto.js reloads once unlocked).
    wc.on('dom-ready', () => { if (this.panelOpen) wc.send('onegy:panel', { open: true }); });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.showOffline(url, desc);
    });
    wc.on('render-process-gone', (_e, details) => {
      console.error(`[WINDOW] site renderer gone: ${details.reason}`);
      this.showOffline(wc.getURL(), 'The page stopped working');
    });
    if (load) wc.loadURL(origin + this.takeResumePath());
  }

  // The page to open first: where the user was before an update restart, once.
  takeResumePath() {
    const p = this.resumePath || START_PATH;
    this.resumePath = null;
    return p;
  }

  // App lock: drop the site view (its sessionStorage keys die with it) and the
  // site cookies; the device-bound website session also ends server-side when
  // the grant is dropped. The panel shows the lock screen over the empty view.
  async lockSite() {
    this.siteLocked = true;
    this.recreateSite(false);
    await this.clearSiteSession();
  }

  // Ends the website session in this app (its cookies).
  clearSiteSession() {
    return session.fromPartition(SITE_PARTITION).clearStorageData({ origin: this.opts.serverOrigin(), storages: ['cookies'] })
      .catch((err) => console.error(`[WINDOW] clearing site cookies failed: ${err.message}`));
  }

  // App unlocked: sign the site view in with a one-use device ticket
  // (sent as a header, never in the URL) and open pathname.
  unlockSite({ url, ticket }, pathname = this.takeResumePath()) {
    this.siteLocked = false;
    const next = new URLSearchParams({ next: pathname });
    const wc = this.site.webContents;
    // Signed in, the pages before (sign-in, lock) are no place to go back to.
    wc.once('did-finish-load', () => {
      wc.navigationHistory.clear();
      this.sendTitlebar();
    });
    wc.loadURL(`${url}?${next}`, { extraHeaders: `X-Onegy-Desktop-Ticket: ${ticket}\n` });
  }

  // A small local page with Retry instead of a blank window; it also tries
  // again by itself, waiting longer each time (n).
  showOffline(failedUrl, reason) {
    const origin = this.opts.serverOrigin();
    const retry = originOf(failedUrl) === origin ? failedUrl : origin + START_PATH;
    const q = new URLSearchParams({
      url: retry, reason: String(reason || '').slice(0, 200), theme: this.opts.settings.get().theme, n: String(this.offlineRetries),
    });
    this.offlineRetries += 1;
    this.site.webContents.loadURL(`${OFFLINE_URL}?${q}`);
  }

  // Whether the site page has something in progress an update restart would
  // lose (an upload, unsaved edits, playing music): core.js OneGyUpdate.busy().
  siteBusy() {
    const wc = this.site && !this.site.webContents.isDestroyed() && !this.siteLocked ? this.site.webContents : null;
    if (!wc || originOf(wc.getURL()) !== this.opts.serverOrigin()) return Promise.resolve(false);
    return wc.executeJavaScript('Boolean(window.OneGyUpdate && window.OneGyUpdate.busy())')
      .then((busy) => busy === true)
      .catch(() => false);
  }

  // Server URL changed: drop the old view (and its preload origin) and rebuild.
  recreateSite(load = !this.siteLocked) {
    if (this.site) {
      this.win.contentView.removeChildView(this.site);
      this.site.webContents.close();
      this.site = null;
    }
    this.siteUser = null;
    this.siteInset = 0;
    this.siteTitle = 'ONE.GY';
    this.siteWanted = null;
    this.createSite(load);
    this.layout();
  }

  scheduleNudge() {
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.opts.onSiteMutation(), NUDGE_DEBOUNCE_MS);
  }

  layout() {
    const { width, height } = this.win.getContentBounds();
    const top = Math.min(TITLEBAR_H, height);
    const inset = Math.min(width, Math.round(this.siteInset * this.opts.settings.get().site_zoom));
    if (this.titlebar) this.titlebar.setBounds({ x: 0, y: 0, width, height: top });
    if (this.site) this.site.setBounds({ x: 0, y: top, width, height: height - top });
    if (this.panel) this.panel.setBounds({ x: inset, y: top, width: width - inset, height: height - top });
    if (this.notice) {
      const w = Math.min(NOTICE_W, width);
      const h = Math.min(this.noticeHeight, height - top);
      this.notice.setBounds({ x: width - w, y: height - h, width: w, height: h });
    }
  }

  // The toast page's card height (CSS px); 0 hides the view.
  setNoticeHeight(px) {
    if (px === this.noticeHeight) return;
    this.noticeHeight = px;
    this.notice.setVisible(px > 0);
    this.layout();
  }

  setUpdate(state) {
    this.update = state;
    this.sendUpdate();
  }

  sendUpdate() {
    if (this.notice && !this.notice.webContents.isDestroyed() && this.update) {
      this.notice.webContents.send('onegy:update', { ...this.update, theme: this.theme });
    }
  }

  isNoticeSender(wc) {
    return Boolean(this.notice && wc === this.notice.webContents);
  }

  // Where the user is, for the restart after an update (main.js).
  snapshot() {
    const wc = this.site && !this.site.webContents.isDestroyed() && !this.siteLocked ? this.site.webContents : null;
    let at = null;
    try { at = wc ? new URL(wc.getURL()) : null; } catch { /* no page */ }
    return {
      hidden: !this.win.isVisible(),
      maximized: this.win.isMaximized(),
      bounds: this.win.getNormalBounds(),
      path: at && at.origin === this.opts.serverOrigin() ? at.pathname + at.search : null,
      panel: this.panelOpen ? this.panelScreen : null,
    };
  }

  // The site's rail width (CSS px) as its preload measured it; 0 = no rail.
  setSiteInset(px) {
    if (px === this.siteInset) return;
    this.siteInset = px;
    this.layout();
  }

  // Title, history buttons and theme for the title bar view.
  sendTitlebar() {
    // Quitting destroys the window before its views, which still fire events.
    if (this.win.isDestroyed() || !this.titlebar || this.titlebar.webContents.isDestroyed()) return;
    const wc = this.site && !this.site.webContents.isDestroyed() ? this.site.webContents : null;
    const browsing = Boolean(wc) && !this.siteLocked && !this.panelOpen;
    const title = this.panelOpen ? (this.panel.webContents.getTitle() || 'ONE.GY') : (this.siteLocked ? 'ONE.GY' : this.siteTitle);
    // The taskbar names the app; the title bar shows the page.
    this.win.setTitle(title.includes('ONE.GY') ? title : `${title} · ONE.GY`);
    this.titlebar.webContents.send('onegy:titlebar', {
      title,
      theme: this.theme,
      canGoBack: browsing && wc.navigationHistory.canGoBack(),
      canGoForward: browsing && wc.navigationHistory.canGoForward(),
      canReload: browsing,
    });
  }

  // The colours the title bar painted (rgb()/rgba() strings, checked by ipc.js).
  setTitlebarColors(color, symbolColor) {
    if (process.platform !== 'darwin') this.win.setTitleBarOverlay(this.overlay([color, symbolColor]));
  }

  isTitlebarSender(wc) {
    return Boolean(this.titlebar && wc === this.titlebar.webContents);
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
    this.layout();
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
      status: this.opts.siteStatus(),
    };
    this.panelScreen = data.screen;
    this.panelWanted = true;
    if (this.panelOpen) this.sendPanelState();
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
      this.sendPanelState();
    }
    this.panel.webContents.focus();
  }

  // Hides the panel at once; the panel UI calls it when it has faded out.
  closePanel() {
    if (this.siteLocked) return;
    this.panelWanted = false;
    clearTimeout(this.showTimer);
    if (!this.panelOpen) return;
    this.panel.setVisible(false);
    this.sendPanelState();
    this.site.webContents.focus();
  }

  // A link in the site's rail was clicked (site preload): the panel fades out
  // over the page it opens; now: no page to wait for (a rail menu opened).
  leavePanel(now = false) {
    if (!this.panelOpen) return;
    const close = () => this.send({ type: 'app:navigate', data: { screen: 'close' } });
    if (now) close();
    else this.siteReady().then(close);
  }

  // The site preload marks html[data-desktop-panel] so the rail shows Sync or
  // App settings as the current place; the title bar shows the panel's title.
  sendPanelState() {
    const mode = SETTINGS_SCREENS.has(this.panelScreen) ? 'settings' : 'sync';
    if (this.site && !this.site.webContents.isDestroyed()) this.site.webContents.send('onegy:panel', { open: this.panelOpen, mode });
    this.sendTitlebar();
  }

  // Load a path on the server in the site view (e.g. /account, /files/folder/12)
  // under the panel; resolves once the page is there for the panel to fade out over.
  openSitePath(pathname) {
    if (this.siteLocked) return Promise.resolve();
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

  // This computer's syncs for the website (onSyncs subscribers).
  sendSiteSyncs(list) {
    if (this.site && !this.site.webContents.isDestroyed()) this.site.webContents.send('onegy:site-syncs', list);
  }

  setTheme() {
    const bg = this.background;
    this.win.setBackgroundColor(bg);
    this.site.setBackgroundColor(bg);
    this.titlebar.setBackgroundColor(TITLEBAR_COLORS[this.theme][0]);
    if (process.platform !== 'darwin') this.win.setTitleBarOverlay(this.overlay());
    this.sendTitlebar();
    this.sendUpdate();
  }

  show() {
    if (!this.win) return;
    // maximize() also shows a hidden window, so it waits for the first show.
    if (this.maximizeOnShow) {
      this.maximizeOnShow = false;
      this.win.maximize();
    }
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }
}

module.exports = {
  MainWindow, isMainFrameOf, SITE_PARTITION, BACKGROUND, SETTINGS_SCREENS,
};
