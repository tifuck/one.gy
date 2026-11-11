// Bridge for the website view, version 3 (desktop/docs/site-bridge.md):
// window.onegyDesktop = { version, bridge, unlock(), openSync(), openSettings(),
// onStatus(), onSyncs() }, only on the top-level frame of the configured
// server origin. For the app it also reports the site's theme
// (html[data-theme]) and the width of its rail ([data-desktop-rail], the
// panel starts right of it), marks html[data-desktop-panel="sync|settings"]
// while the panel is open (a rail link closes it), and hands the site's
// sign-out (form.js-logout-form) to the app first. The main process re-checks
// the sender frame for every call.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_VERSION = 3;
const SCREENS = new Set(['syncs', 'transfers', 'issues', 'settings']);
const SETTINGS = new Set(['general', 'account', 'security', 'updates', 'about']);
const SYNC_TYPES = new Set(['two_way', 'backup', 'mirror', 'archive', 'full']);
const SYNC_STATES = new Set(['up_to_date', 'syncing', 'paused', 'issues', 'offline', 'error', 'locked']);

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

  const syncListeners = new Set();
  let lastSyncs = null;
  let syncsSubscribed = false;
  const cleanSync = (s) => Object.freeze({
    id: String(s.id),
    folder_id: Number.isSafeInteger(s.folder_id) && s.folder_id > 0 ? s.folder_id : null,
    type: SYNC_TYPES.has(s.type) ? s.type : 'two_way',
    state: SYNC_STATES.has(s.state) ? s.state : 'error',
    pending: Number(s.pending) || 0,
    issues: Number(s.issues) || 0,
  });
  const deliverSyncs = (list) => {
    if (!Array.isArray(list)) return;
    lastSyncs = Object.freeze(list.filter((s) => s && typeof s.id === 'string').map(cleanSync));
    for (const cb of syncListeners) {
      try { cb(lastSyncs); } catch (err) { console.error(err); }
    }
  };
  ipcRenderer.on('onegy:site-syncs', (_e, list) => deliverSyncs(list));

  // The panel covers the page but not the rail: a rail link leaves it.
  let panelOpen = false;
  ipcRenderer.on('onegy:panel', (_e, state) => {
    panelOpen = Boolean(state && state.open);
    if (panelOpen) document.documentElement.setAttribute('data-desktop-panel', state.mode === 'settings' ? 'settings' : 'sync');
    else document.documentElement.removeAttribute('data-desktop-panel');
  });
  document.addEventListener('click', (e) => {
    if (panelOpen && e.target instanceof Element && e.target.closest('[data-desktop-rail] a[href]')) ipcRenderer.send('site:leavePanel');
  }, true);

  // Signed in on this computer, the site's sign-out signs out of the app (main
  // asks first); otherwise ('site') the form goes through as usual. Window
  // capture runs before the site's own submit hooks (core.js clears keys).
  let logoutPassThrough = false;
  window.addEventListener('submit', (e) => {
    const form = e.target instanceof HTMLFormElement && e.target.matches('form.js-logout-form') ? e.target : null;
    if (!form || logoutPassThrough) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ipcRenderer.invoke('site:logout').then((result) => {
      if (result !== 'site') return;
      logoutPassThrough = true;
      form.requestSubmit();
    }, () => {});
  }, true);

  contextBridge.exposeInMainWorld('onegyDesktop', Object.freeze({
    version,
    bridge: BRIDGE_VERSION,
    // Resolves to the account master key (ArrayBuffer) or null. Only for a
    // page signed in as this computer's account (the nav's data-username).
    unlock: async () => {
      if (document.readyState === 'loading') {
        await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
      }
      const b64 = await ipcRenderer.invoke('site:unlock', pageUsername());
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
    // The app's own settings (window, account, security, updates, about).
    openSettings: (opts) => {
      const o = opts && typeof opts === 'object' ? opts : {};
      if (typeof o.username !== 'string' || !o.username) return;
      ipcRenderer.send('site:openSync', { username: o.username, screen: SETTINGS.has(o.section) ? o.section : 'general' });
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
    // This computer's syncs: [{ id, folder_id (null = drive root), type, state, pending, issues }].
    onSyncs: (cb) => {
      if (typeof cb !== 'function') return () => {};
      syncListeners.add(cb);
      if (lastSyncs) {
        try { cb(lastSyncs); } catch (err) { console.error(err); }
      }
      if (!syncsSubscribed) {
        syncsSubscribed = true;
        ipcRenderer.invoke('site:syncs', pageUsername()).then(deliverSyncs, () => {});
      }
      return () => { syncListeners.delete(cb); };
    },
  }));

  const reportTheme = () => {
    const theme = document.documentElement && document.documentElement.getAttribute('data-theme');
    if (theme) ipcRenderer.send('site:theme', theme);
  };
  // The rail's right edge in CSS px (0: no rail, e.g. the sign-in page).
  let lastInset = -1;
  const reportInset = (rail) => {
    const px = rail && rail.isConnected ? Math.max(0, rail.getBoundingClientRect().right) : 0;
    if (px === lastInset) return;
    lastInset = px;
    ipcRenderer.send('site:inset', px);
  };
  window.addEventListener('DOMContentLoaded', () => {
    reportTheme();
    new MutationObserver(reportTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const rail = document.querySelector('[data-desktop-rail]');
    reportInset(rail);
    if (rail) new ResizeObserver(() => reportInset(rail)).observe(rail);
  });
}
