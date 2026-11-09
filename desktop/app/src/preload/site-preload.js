// Bridge for the website view, version 2 (desktop/docs/site-bridge.md):
// window.onegyDesktop = { version, bridge, unlock(), openSync(), onStatus() },
// only on the top-level frame of the configured server origin. It also
// reports the site's theme (html[data-theme]) so the sync panel follows it.
// The main process re-checks the sender frame for every call.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_VERSION = 2;
const SCREENS = new Set(['syncs', 'transfers', 'issues', 'settings']);

function arg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const origin = arg('onegy-origin');
const version = arg('onegy-version') || '';

// The signed-in user as the template renders it (the Sync entry), for the
// other_account state of onStatus.
const pageUsername = () => {
  const el = document.querySelector('[data-desktop-sync][data-username]');
  return el ? el.getAttribute('data-username') : null;
};

if (origin && window.location.origin === origin && window.top === window) {
  const listeners = new Set();
  let last = null;
  let subscribed = false;
  const deliver = (status) => {
    if (!status || typeof status.state !== 'string') return;
    last = Object.freeze({ state: status.state, pending: Number(status.pending) || 0, issues: Number(status.issues) || 0 });
    for (const cb of listeners) {
      try { cb(last); } catch (err) { console.error(err); }
    }
  };
  ipcRenderer.on('onegy:site-status', (_e, status) => deliver(status));

  contextBridge.exposeInMainWorld('onegyDesktop', Object.freeze({
    version,
    bridge: BRIDGE_VERSION,
    // Resolves to the account master key (ArrayBuffer) or null.
    unlock: async () => {
      const b64 = await ipcRenderer.invoke('site:unlock');
      if (typeof b64 !== 'string' || !b64) return null;
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      } catch {
        return null;
      }
    },
    openSync: (opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      if (typeof o.username !== 'string' || !o.username) return;
      ipcRenderer.send('site:openSync', { username: o.username, screen: SCREENS.has(o.screen) ? o.screen : 'syncs' });
    },
    onStatus: (cb) => {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      if (last) {
        try { cb(last); } catch (err) { console.error(err); }
      }
      if (!subscribed) {
        subscribed = true;
        ipcRenderer.invoke('site:status', pageUsername()).then(deliver, () => {});
      }
      return () => { listeners.delete(cb); };
    },
  }));

  const reportTheme = () => {
    const theme = document.documentElement && document.documentElement.getAttribute('data-theme');
    if (theme) ipcRenderer.send('site:theme', theme);
  };
  window.addEventListener('DOMContentLoaded', () => {
    reportTheme();
    new MutationObserver(reportTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  });
}
