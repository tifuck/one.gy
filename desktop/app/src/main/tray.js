// Tray icon and menu. Before this computer is authorized for sync: only
// "Open ONE.GY" and "Quit". After: status line, Open ONE.GY, Sync… (the sync
// panel), pause/resume, Upload…, Quit (desktop/docs/site-bridge.md).
'use strict';

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

const ICON_DIR = path.join(__dirname, '..', 'assets', 'tray');

// Engine status.state -> icon name.
const ICON_FOR = {
  up_to_date: 'synced',
  syncing: 'syncing',
  paused: 'paused',
  issues: 'issue',
  offline: 'offline',
  locked: 'issue',
  signed_out: 'offline',
};

function statusLine(status, engineState) {
  if (engineState !== 'connected') return engineState === 'missing' ? 'Sync engine not found' : 'Starting sync engine…';
  if (!status) return 'Connecting…';
  switch (status.state) {
    case 'up_to_date': return 'Up to date';
    case 'syncing': return status.pending ? `Syncing ${status.pending} item${status.pending === 1 ? '' : 's'}` : 'Syncing';
    case 'paused': return 'Paused';
    case 'offline': return 'Offline';
    case 'issues': return 'Needs your attention';
    case 'locked': return 'Locked: unlock to start syncing';
    case 'signed_out': return 'Not set up yet';
    default: return 'ONE.GY';
  }
}

function loadIcon(name) {
  // Windows picks @2x automatically; Linux panels want the larger image, with
  // the mark centred when there is no badge (make-icons.js).
  const file = process.platform === 'win32' ? `tray-${name}.png`
    : process.platform === 'linux' ? `tray-${name}-linux.png` : `tray-${name}@2x.png`;
  return nativeImage.createFromPath(path.join(ICON_DIR, file));
}

// The menu template (labels and actions), without Electron.
function menuTemplate({
  authorized, status, engineState, pausedUntil, appLocked, canLock,
}, a) {
  const open = { label: appLocked ? 'Unlock ONE.GY…' : 'Open ONE.GY', click: () => a.open() };
  const quit = { label: 'Quit ONE.GY', click: () => a.quit() };
  if (!authorized) return [open, { type: 'separator' }, quit];
  // Locked: syncing goes on, everything else waits for the PIN or password.
  if (appLocked) return [{ label: statusLine(status, engineState), enabled: false }, { type: 'separator' }, open, { type: 'separator' }, quit];
  const lock = canLock ? [{ label: 'Lock ONE.GY', click: () => a.lock() }] : [];
  const connected = engineState === 'connected';
  const paused = Boolean(status && status.state === 'paused');
  const pauseItems = paused
    ? [{ label: pausedUntil ? `Resume (paused until ${new Date(pausedUntil).toLocaleTimeString()})` : 'Resume syncing', click: () => a.resumeAll(), enabled: connected }]
    : [
      { label: 'Pause for 1 hour', click: () => a.pauseAll(60 * 60 * 1000), enabled: connected },
      { label: 'Pause until resumed', click: () => a.pauseAll(null), enabled: connected },
    ];
  return [
    { label: statusLine(status, engineState), enabled: false },
    { type: 'separator' },
    open,
    { label: 'Sync…', click: () => a.openSync() },
    { type: 'separator' },
    ...pauseItems,
    { label: 'Upload…', click: () => a.upload(), enabled: connected },
    { type: 'separator' },
    ...lock,
    quit,
  ];
}

class AppTray {
  // actions: { open, lock, openSync, pauseAll(ms|null), resumeAll, upload, quit }
  constructor(actions) {
    this.actions = actions;
    this.state = {
      authorized: false, status: null, engineState: 'connecting', pausedUntil: null, appLocked: false, canLock: false,
    };
    this.tray = new Tray(loadIcon('offline'));
    this.tray.on('click', () => actions.open());
    this.render();
  }

  // patch: any of { authorized, status, engineState, pausedUntil }
  update(patch) {
    Object.assign(this.state, patch);
    this.render();
  }

  render() {
    const { authorized, status, engineState } = this.state;
    const connected = engineState === 'connected';
    const icon = authorized && connected && status ? ICON_FOR[status.state] : null;
    this.tray.setImage(loadIcon(icon || 'offline'));
    this.tray.setToolTip(authorized ? `ONE.GY: ${statusLine(status, engineState)}` : 'ONE.GY');
    this.tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(this.state, this.actions)));
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { AppTray, statusLine, menuTemplate, ICON_FOR };
