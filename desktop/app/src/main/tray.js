// Tray icon and menu (plan 10.7): status icon per overall state, status line,
// recent changes, pause/resume, manual upload/download, settings, quit.
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
    case 'locked': return 'Locked: enter your password';
    case 'signed_out': return 'Not set up yet';
    default: return 'ONE.GY Desktop';
  }
}

function loadIcon(name) {
  // Windows picks @2x automatically; Linux panels want the larger image.
  const file = process.platform === 'win32' ? `tray-${name}.png` : `tray-${name}@2x.png`;
  return nativeImage.createFromPath(path.join(ICON_DIR, file));
}

class AppTray {
  // actions: { open, navigate(screen), pauseAll(ms|null), resumeAll, upload, download, reveal(item), quit }
  constructor(actions) {
    this.actions = actions;
    this.status = null;
    this.engineState = 'connecting';
    this.recent = [];
    this.pausedUntil = null;
    this.tray = new Tray(loadIcon('offline'));
    this.tray.setToolTip('ONE.GY Desktop');
    this.tray.on('click', () => actions.open());
    this.render();
  }

  update({ status, engineState, recent, pausedUntil }) {
    if (status !== undefined) this.status = status;
    if (engineState !== undefined) this.engineState = engineState;
    if (recent !== undefined) this.recent = recent.slice(0, 5);
    if (pausedUntil !== undefined) this.pausedUntil = pausedUntil;
    this.render();
  }

  render() {
    const a = this.actions;
    const connected = this.engineState === 'connected';
    const state = connected && this.status ? this.status.state : 'offline';
    const line = statusLine(this.status, this.engineState);
    this.tray.setImage(loadIcon(ICON_FOR[state] || 'offline'));
    this.tray.setToolTip(`ONE.GY Desktop: ${line}`);

    const paused = state === 'paused';
    const recentItems = this.recent.length
      ? this.recent.map((item) => ({ label: `${item.action} ${item.path}`.slice(0, 80), click: () => a.reveal(item) }))
      : [{ label: 'Nothing yet', enabled: false }];
    const pauseItems = paused
      ? [{ label: this.pausedUntil ? `Resume (paused until ${new Date(this.pausedUntil).toLocaleTimeString()})` : 'Resume syncing', click: () => a.resumeAll(), enabled: connected }]
      : [
        { label: 'Pause for 1 hour', click: () => a.pauseAll(60 * 60 * 1000), enabled: connected },
        { label: 'Pause until resumed', click: () => a.pauseAll(null), enabled: connected },
      ];

    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: line, enabled: false },
      { type: 'separator' },
      { label: 'Open ONE.GY', click: () => a.open() },
      { label: 'Recent changes', submenu: recentItems },
      { type: 'separator' },
      ...pauseItems,
      { type: 'separator' },
      { label: 'Upload…', click: () => a.upload(), enabled: connected },
      { label: 'Download…', click: () => a.download(), enabled: connected },
      { label: 'Settings', click: () => a.navigate('settings') },
      { type: 'separator' },
      { label: 'Quit ONE.GY Desktop', click: () => a.quit() },
    ]));
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { AppTray, statusLine, ICON_FOR };
