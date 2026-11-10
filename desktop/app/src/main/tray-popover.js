// The tray popover (app://ui/popover.html): a small window by the tray icon
// with the account at a glance (overall state and speed, storage, each sync,
// transfers now and recently finished, open issues). Tray left click opens
// it where the system reports one (Windows, KDE and most StatusNotifierItem
// hosts); the tray menu's "Status and activity…" opens it everywhere (GNOME's
// AppIndicator shows the menu on left click). It hides when it loses focus,
// on Esc and on its close button. Linux reports no tray bounds, so it opens
// by the pointer; Wayland compositors place windows themselves.
'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { webPreferences, lockChromeView } = require('./security');
const { POPOVER_URL } = require('./protocol');

const SIZE = { width: 640, height: 400 };
const GAP = 8;
// The tray click that took the focus away (and hid it) must not reopen it.
const REOPEN_GUARD_MS = 300;
// Actions that leave the popover; pause and resume keep it open.
const STAYS_OPEN = new Set(['pause', 'resume']);

// Top-left corner for a popover of `size` by `anchor` (the tray icon's centre
// or the pointer), inside the work area `area`: centred on the anchor
// horizontally, against the edge the anchor is nearest to (the taskbar's).
function placePopover(size, anchor, area, gap = GAP) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const x = clamp(Math.round(anchor.x - size.width / 2), area.x + gap, area.x + area.width - size.width - gap);
  const top = anchor.y < area.y + area.height / 2;
  return { x, y: top ? area.y + gap : area.y + area.height - size.height - gap };
}

class TrayPopover {
  // opts: { background(): string, state(): object (sent on every show),
  //         actions: { name: (arg) => void } (popover:action, ipc.js) }
  constructor(opts) {
    this.opts = opts;
    this.win = null;
    this.loaded = null;
    this.hiddenAt = 0;
  }

  get visible() {
    return Boolean(this.win && this.win.isVisible());
  }

  isSender(wc) {
    return Boolean(this.win && wc === this.win.webContents);
  }

  create() {
    this.win = new BrowserWindow({
      ...SIZE,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'ONE.GY',
      backgroundColor: this.opts.background(),
      webPreferences: webPreferences({ preload: path.join(__dirname, '..', 'preload', 'popover-preload.js') }),
    });
    lockChromeView(this.win.webContents);
    this.win.on('blur', () => this.hide());
    this.win.on('closed', () => { this.win = null; });
    this.loaded = new Promise((resolve) => this.win.webContents.once('did-finish-load', resolve));
    this.win.loadURL(POPOVER_URL);
  }

  // bounds: the tray icon's (Tray 'click'); empty or missing = by the pointer.
  toggle(bounds) {
    if (this.visible) return this.hide();
    if (Date.now() - this.hiddenAt < REOPEN_GUARD_MS) return undefined;
    return this.show(bounds);
  }

  async show(bounds) {
    if (!this.win) this.create();
    const anchor = bounds && bounds.width > 0
      ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    const size = { width: Math.min(SIZE.width, area.width - 2 * GAP), height: Math.min(SIZE.height, area.height - 2 * GAP) };
    this.win.setBounds({ ...placePopover(size, anchor, area), ...size });
    this.win.setBackgroundColor(this.opts.background());
    await this.loaded;
    if (!this.win) return;
    this.win.webContents.send('onegy:popover', this.opts.state());
    this.win.show();
    this.win.focus();
  }

  hide() {
    if (!this.visible) return;
    this.hiddenAt = Date.now();
    this.win.hide();
  }

  run(name, arg) {
    if (typeof name !== 'string' || !Object.hasOwn(this.opts.actions, name)) return;
    if (!STAYS_OPEN.has(name)) this.hide();
    this.opts.actions[name](arg);
  }

  // Engine and app events, as the panel gets them (window.js send).
  send(event) {
    if (this.win) this.win.webContents.send('onegy:event', event);
  }
}

module.exports = { TrayPopover, placePopover, SIZE };
