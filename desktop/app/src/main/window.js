// The one app window: a BaseWindow holding two WebContentsViews.
//  - chrome: native UI from app://ui (rail, toolbar, native screens)
//  - site:   https://<server> in partition persist:onegy, placed over the
//            slot the chrome UI reports, visible only on Files/Notes/Music.
'use strict';

const path = require('path');
const { app, BaseWindow, WebContentsView, nativeImage, session } = require('electron');
const { webPreferences, lockChromeView, lockSiteView, configureSiteSession, originOf } = require('./security');
const { UI_URL } = require('./protocol');

const SITE_PARTITION = 'persist:onegy';
const SITE_SECTIONS = { files: '/files', notes: '/notes', music: '/music' };
const BACKGROUND = { 'frost-dark': '#08080a', frost: '#ffffff' };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NUDGE_DEBOUNCE_MS = 1500;

function sectionOf(url, origin) {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return null;
    const first = u.pathname.split('/')[1] || '';
    if (first === 'files' || first === 'trash') return 'files';
    if (first === 'notes') return 'notes';
    if (first === 'music') return 'music';
  } catch { /* not a URL */ }
  return null;
}

function isMainFrameOf(frame, wc) {
  const main = wc && !wc.isDestroyed() ? wc.mainFrame : null;
  return Boolean(frame && main && !frame.parent
    && frame.processId === main.processId && frame.routingId === main.routingId);
}

class MainWindow {
  // opts: { settings (SettingsStore), serverOrigin(): string, onSiteMutation(): void }
  constructor(opts) {
    this.opts = opts;
    this.win = null;
    this.chrome = null;
    this.site = null;
    this.siteBounds = null;
    this.siteWanted = false;
    this.section = null;
    this.nudgeTimer = null;
  }

  create({ show }) {
    const theme = this.opts.settings.get().theme;
    this.win = new BaseWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 520,
      show: false,
      title: 'ONE.GY Desktop',
      backgroundColor: BACKGROUND[theme] || BACKGROUND['frost-dark'],
      icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')),
      autoHideMenuBar: true,
    });

    this.chrome = new WebContentsView({
      webPreferences: webPreferences({ preload: path.join(__dirname, '..', 'preload', 'app-preload.js') }),
    });
    this.chrome.setBackgroundColor(BACKGROUND[theme] || BACKGROUND['frost-dark']);
    lockChromeView(this.chrome.webContents);
    this.win.contentView.addChildView(this.chrome);
    this.layout();
    this.win.on('resize', () => this.layout());
    this.chrome.webContents.loadURL(UI_URL);
    this.chrome.webContents.once('did-finish-load', () => { if (show) this.show(); });
    this.allowDevTools(this.chrome.webContents);

    this.configureSiteSession();
    this.createSite();
    return this.win;
  }

  allowDevTools(wc) {
    if (app.isPackaged) return;
    wc.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        wc.toggleDevTools();
      }
    });
  }

  // Once per run: permissions, downloads, and the change hook that nudges the
  // engine after the user changes something on the website.
  configureSiteSession() {
    const ses = session.fromPartition(SITE_PARTITION);
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
    const wc = this.site.webContents;
    lockSiteView(wc, () => this.opts.serverOrigin());
    this.allowDevTools(wc);
    this.site.setVisible(false);
    this.win.contentView.addChildView(this.site);
    const report = () => this.sendSiteState();
    const navigated = () => {
      this.section = sectionOf(wc.getURL(), this.opts.serverOrigin());
      report();
    };
    wc.on('did-navigate', navigated);
    wc.on('did-navigate-in-page', navigated);
    wc.on('did-start-loading', report);
    wc.on('did-stop-loading', report);
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.sendSiteState({ error: `Could not load ${originOf(url) || 'the page'} (${desc})` });
    });
    wc.on('render-process-gone', (_e, details) => {
      console.error(`[WINDOW] site renderer gone: ${details.reason}`);
      this.sendSiteState({ error: 'The page stopped working. Reload to try again.' });
    });
    this.applySiteBounds();
  }

  // Server URL changed: drop the old view (and its preload origin) and rebuild.
  recreateSite() {
    if (this.site) {
      this.win.contentView.removeChildView(this.site);
      this.site.webContents.close();
      this.site = null;
    }
    const section = this.section || 'files';
    this.section = null;
    this.createSite();
    if (this.siteWanted) this.view(section, true);
  }

  scheduleNudge() {
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.opts.onSiteMutation(), NUDGE_DEBOUNCE_MS);
  }

  layout() {
    const { width, height } = this.win.getContentBounds();
    this.chrome.setBounds({ x: 0, y: 0, width, height });
  }

  // The chrome UI reports where the site slot is (CSS px == DIP).
  setSiteBounds(rect) {
    this.siteBounds = rect;
    this.applySiteBounds();
  }

  applySiteBounds() {
    if (!this.site) return;
    const visible = Boolean(this.siteWanted && this.siteBounds);
    const wasVisible = this.site.getVisible();
    if (visible) this.site.setBounds(this.siteBounds);
    this.site.setVisible(visible);
    if (visible && !wasVisible) this.site.webContents.focus();
  }

  // screen: files|notes|music show that section of the site (kept where the
  // user left it unless `reset`); web shows the site as is; anything else
  // hides it.
  view(screen, reset) {
    const route = SITE_SECTIONS[screen];
    this.siteWanted = Boolean(route) || screen === 'web';
    if (route && (reset || this.section !== screen)) {
      this.section = screen;
      this.site.webContents.loadURL(this.opts.serverOrigin() + route);
    }
    this.applySiteBounds();
  }

  // Load a path on the server in the site view (e.g. /account, /files/folder/12).
  openSitePath(pathname) {
    const url = this.opts.serverOrigin() + pathname;
    this.section = sectionOf(url, this.opts.serverOrigin());
    this.site.webContents.loadURL(url);
    this.navigate(this.section || 'web');
  }

  siteNav(action) {
    const nav = this.site.webContents.navigationHistory;
    if (action === 'back' && nav.canGoBack()) nav.goBack();
    else if (action === 'forward' && nav.canGoForward()) nav.goForward();
    else if (action === 'reload') this.site.webContents.reload();
  }

  sendSiteState(extra) {
    if (!this.site) return;
    const wc = this.site.webContents;
    const nav = wc.navigationHistory;
    this.send({
      type: 'app:site',
      data: {
        url: wc.getURL(),
        loading: wc.isLoading(),
        canGoBack: nav.canGoBack(),
        canGoForward: nav.canGoForward(),
        section: sectionOf(wc.getURL(), this.opts.serverOrigin()),
        error: null,
        ...extra,
      },
    });
  }

  isSiteFrame(frame) {
    return Boolean(this.site && isMainFrameOf(frame, this.site.webContents)
      && originOf(frame.url) === this.opts.serverOrigin());
  }

  isChromeSender(wc) {
    return Boolean(this.chrome && wc === this.chrome.webContents);
  }

  send(event) {
    if (this.chrome && !this.chrome.webContents.isDestroyed()) this.chrome.webContents.send('onegy:event', event);
  }

  setTheme(theme) {
    const bg = BACKGROUND[theme] || BACKGROUND['frost-dark'];
    this.win.setBackgroundColor(bg);
    this.chrome.setBackgroundColor(bg);
  }

  show() {
    if (!this.win) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  navigate(screen) {
    this.show();
    this.send({ type: 'app:navigate', data: { screen } });
  }
}

module.exports = { MainWindow, sectionOf, isMainFrameOf, SITE_PARTITION };
