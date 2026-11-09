// Bridge for the website view, version 2 (desktop/docs/site-bridge.md):
// window.onegyDesktop = { version, bridge, unlock(), openSync(), onStatus() },
// only on the top-level frame of the configured server origin. For the sync
// panel it also reports the site's theme (html[data-theme]) and its nav as
// plain values, and on the panel's behalf clicks the site's own theme option
// or submits its own logout form. The main process re-checks the sender frame
// for every call.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_VERSION = 2;
const SCREENS = new Set(['syncs', 'transfers', 'issues', 'settings']);
const THEMES = new Set(['frost', 'frost-dark']);

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

// The site nav (templates/_nav.html) as values: never markup. Paths only for
// links on this origin; main/site-nav.js validates again.
function navData() {
  const nav = document.querySelector('header.rd-nav');
  if (!nav) return null;
  const text = (el) => (el ? el.textContent.trim() : '');
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
  const sitePath = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.origin === origin ? u.pathname + u.search : null;
    } catch {
      return null;
    }
  };
  const links = [...nav.querySelectorAll('.rd-nav-mid a.rd-nav-link')].map((a) => {
    const badge = a.querySelector('.rd-badge');
    return {
      label: ownText(a),
      href: sitePath(a.href),
      active: a.classList.contains('is-active'),
      badge: badge && !badge.hidden ? Number.parseInt(badge.textContent, 10) || 0 : 0,
    };
  });
  const user = nav.querySelector('.rd-menu-user');
  const account = nav.querySelector('.rd-menu-pop a.rd-menu-item[href]');
  const accountPath = account ? sitePath(account.href) : null;
  const short = accountPath && [...nav.querySelectorAll('.rd-nav-drawer a.rd-nav-link')].find((a) => sitePath(a.href) === accountPath);
  const avatar = nav.querySelector('.rd-avatar-btn img');
  return {
    links,
    username: text(user && user.querySelector('b')),
    role: text(user && user.querySelector('span')),
    account: account ? { label: text(account), short: text(short), href: accountPath } : null,
    avatar: avatar ? sitePath(avatar.src) : null,
  };
}

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

  // Asked by the panel's theme menu / avatar menu: the site's own controls do it.
  ipcRenderer.on('onegy:site-theme', (_e, theme) => {
    const option = THEMES.has(theme) && document.querySelector(`[data-set-theme="${theme}"]`);
    if (option) option.click();
  });
  ipcRenderer.on('onegy:site-logout', () => {
    const form = document.querySelector('form.js-logout-form');
    if (form) form.requestSubmit();
  });

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
  // The nav changes after load (notes badge, sync status): report what differs.
  let lastNav = '';
  let navTimer = null;
  const reportNav = () => {
    navTimer = null;
    const data = navData();
    const key = JSON.stringify(data);
    if (!data || key === lastNav) return;
    lastNav = key;
    ipcRenderer.send('site:nav', data);
  };
  window.addEventListener('DOMContentLoaded', () => {
    reportTheme();
    new MutationObserver(reportTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    reportNav();
    const nav = document.querySelector('header.rd-nav');
    if (nav) {
      new MutationObserver(() => { if (!navTimer) navTimer = setTimeout(reportNav, 150); })
        .observe(nav, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'href', 'src'] });
    }
  });
}
