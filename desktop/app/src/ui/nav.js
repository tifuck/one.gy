// The website's top nav (templates/_nav.html) in the sync panel: the same
// markup and classes, so the vendored site CSS draws it identically. Built
// from the plain values the site reports (main/site-nav.js), never from site
// markup. Sync is the active entry with the site's status dot; every other
// link opens on the site and closes the panel. The avatar and theme menus act
// through the site's own logout form and theme options. Menu and drawer
// behaviour follows the site's core.js.
import { h, svg, fill } from './components/dom.js';

const THEMES = [['frost', 'Frost'], ['frost-dark', 'Frost Dark']];
const MARK = '<svg class="rd-nav-mark" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
  + '<defs><path id="rdMarkKey" d="M13.93 2.52Q14.46 2.52 14.46 3.05L14.46 5.88L14 6.32Q13.86 6.46 14 6.59L14.32 6.9Q14.46 7.03 14.32 7.16L14 7.48Q13.86 7.61 14 7.74L14.32 8.05Q14.46 8.18 14.28 8.25L13.08 8.69Q12.9 8.76 13.08 8.83L14.28 9.27Q14.46 9.34 14.28 9.4L13.08 9.85Q12.9 9.91 13.08 9.98L14.28 10.42Q14.46 10.49 14.32 10.62L14 10.93Q13.86 11.06 14 11.2L14.32 11.51Q14.46 11.64 14.32 11.77L14 12.08Q13.86 12.22 14 12.35L14.32 12.66Q14.46 12.79 14.32 12.92L14 13.24Q13.86 13.37 14 13.5L14.32 13.81Q14.46 13.94 14.28 14.01L13.08 14.45Q12.9 14.52 13.08 14.59L14.46 15.1L14.46 16.44L10.62 16.44L10.62 6.1Q10.62 5.78 10.37 5.97L10.08 6.18Q9.65 6.49 9.34 6.06L8.41 4.78Q8.1 4.35 8.53 4.04L10.2 2.83Q10.62 2.52 11.15 2.52Z"/></defs>'
  + '<g class="rd-mark-shadow"><use href="#rdMarkKey" fill="var(--accent)"/><circle cx="12.54" cy="18.12" r="2.4" stroke="var(--accent)" stroke-width="1.92"/></g>'
  + '<g class="rd-mark-grp"><use class="rd-mark-body" href="#rdMarkKey" fill="currentColor"/>'
  + '<circle cx="12.54" cy="18.12" r="2.4" stroke="currentColor" stroke-width="1.92"/>'
  + '<circle class="rd-mark-hole" cx="12.54" cy="18.12" r=".72" fill="var(--accent)"/>'
  + '<g clip-path="url(#rdMarkClip)"><rect class="rd-mark-sheen" x="2" y="2" width="4" height="20" fill="#ffffff"/></g></g>'
  + '<clipPath id="rdMarkClip"><use href="#rdMarkKey"/><circle cx="12.54" cy="18.12" r="3.36"/></clipPath></svg>';
const PALETTE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="13.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1.5" fill="currentColor" stroke="none"/>'
  + '<circle cx="8.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r="1.5" fill="currentColor" stroke="none"/>'
  + '<path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4 10 10 0 0 0-10-8z"/></svg>';

// Same wording as the site's Sync entry (static/desktop-bridge.js).
function describe(s) {
  const count = (n) => (n > 99 ? '99+' : String(Math.max(0, Math.floor(n))));
  const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;
  switch (s.state) {
    case 'not_set_up': return ['Set up sync on this computer', 'Set up'];
    case 'syncing': return [s.pending > 0 ? `Syncing, ${plural(s.pending, 'transfer', 'transfers')} left` : 'Syncing', s.pending > 0 ? count(s.pending) : ''];
    case 'up_to_date': return ['Up to date', ''];
    case 'issues': return [`${plural(s.issues, 'sync issue needs', 'sync issues need')} a look`, count(s.issues)];
    case 'paused': return ['Sync is paused', ''];
    case 'offline': return ['Offline. Sync resumes when the connection is back', ''];
    case 'locked': return ['Sync is locked. Enter your password to resume', ''];
    case 'other_account': return ['This computer syncs a different account', ''];
    default: return ['Sync', ''];
  }
}

// actions: { open(path), theme(id), logout() }
export function createNav(header, actions) {
  const root = document.documentElement;
  let nav = null;
  let theme = root.dataset.theme;
  let status = null;

  const go = (path) => (e) => {
    e.preventDefault();
    closeAll();
    actions.open(path);
  };
  const avatar = (size) => h('img', {
    class: 'rd-avatar', src: (nav && nav.avatar) || undefined, alt: '', width: size, height: size,
  });
  const syncEntry = () => h('button', {
    class: 'rd-nav-link rd-sync is-active', type: 'button', 'data-desktop-sync': true, 'aria-current': 'page',
  }, 'Sync', h('span', { class: 'rd-sync-dot', 'aria-hidden': 'true' }), h('span', { class: 'rd-sync-note', hidden: true }));
  const logout = (cls) => h('div', { class: 'js-logout-form' },
    h('button', { class: `${cls} rd-menu-danger`, type: 'button', onclick: () => { closeAll(); actions.logout(); } }, 'Log out'));

  function render() {
    const n = nav || { links: [], username: '', role: '', account: null };
    const links = n.links.map((l) => h('a', { class: 'rd-nav-link', href: l.href, onclick: go(l.href) },
      l.label, l.badge ? h('span', { class: 'rd-badge' }, String(l.badge)) : null));
    const userMenu = n.username ? h('div', { class: 'rd-menu', 'data-menu': true },
      h('button', {
        class: 'rd-avatar-btn', 'data-menu-btn': true, 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-label': 'Account menu',
      }, avatar(30)),
      h('div', { class: 'rd-menu-pop rd-menu-right' },
        h('div', { class: 'rd-menu-user' }, avatar(34), h('div', null, h('b', null, n.username), h('span', null, n.role))),
        n.account ? h('a', { class: 'rd-menu-item', href: n.account.href, onclick: go(n.account.href) }, n.account.label) : null,
        h('div', { class: 'rd-menu-sep' }),
        logout('rd-menu-item'))) : null;
    const themeMenu = h('div', { class: 'rd-menu', 'data-menu': true },
      h('button', {
        class: 'rd-icon-btn', 'data-menu-btn': true, 'aria-haspopup': 'true', 'aria-expanded': 'false', title: 'Theme', 'aria-label': 'Theme',
      }, svg(PALETTE)),
      h('div', { class: 'rd-menu-pop' },
        h('div', { class: 'rd-menu-head' }, 'Theme'),
        THEMES.map(([id, label]) => h('button', {
          class: 'rd-menu-item rd-theme-opt', type: 'button', 'data-set-theme': id, 'aria-pressed': String(id === theme),
          onclick: () => { closeAll(); actions.theme(id); },
        }, h('span', { class: 'rd-swatch', 'data-swatch': id }), label, h('span', { class: 'rd-menu-check', 'aria-hidden': 'true' }, '✓')))));
    const toggle = h('button', { class: 'rd-nav-toggle', type: 'button', 'aria-label': 'Toggle menu', 'aria-expanded': 'false' },
      h('span'), h('span'), h('span'));
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle.setAttribute('aria-expanded', String(root.classList.toggle('rd-nav-open')));
    });
    root.classList.remove('rd-nav-open');

    fill(header,
      h('div', { class: 'rd-nav-inner' },
        h('a', { class: 'rd-nav-logo', href: '/files', 'aria-label': 'ONE.GY home', onclick: go('/files') },
          svg(MARK), h('span', { class: 'rd-nav-word' }, 'ONE', h('span', { class: 'rd-accent' }, '.GY'))),
        h('nav', { class: 'rd-nav-mid', 'aria-label': 'Primary' }, links, syncEntry()),
        h('div', { class: 'rd-nav-actions' }, userMenu, themeMenu, toggle)),
      h('div', { class: 'rd-nav-drawer' },
        n.links.map((l) => h('a', { class: 'rd-nav-link', href: l.href, onclick: go(l.href) }, l.label)),
        syncEntry(),
        n.account ? h('a', { class: 'rd-nav-link', href: n.account.href, onclick: go(n.account.href) }, n.account.short) : null,
        n.username ? logout('rd-nav-link') : null));
    renderStatus();
  }

  function renderStatus() {
    const s = status || {};
    const state = typeof s.state === 'string' ? s.state : '';
    const [title, note] = describe({ state, pending: Number(s.pending) || 0, issues: Number(s.issues) || 0 });
    for (const el of header.querySelectorAll('[data-desktop-sync]')) {
      el.setAttribute('data-sync-state', state);
      el.title = title;
      el.setAttribute('aria-label', `Sync: ${title}`);
      const n = el.querySelector('.rd-sync-note');
      n.textContent = note;
      n.hidden = !note;
    }
  }

  // Closes open menus and the drawer; true if anything was open.
  function closeAll(except) {
    let was = root.classList.contains('rd-nav-open');
    root.classList.remove('rd-nav-open');
    const toggle = header.querySelector('.rd-nav-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    for (const m of header.querySelectorAll('.rd-menu.is-open')) {
      if (m === except) continue;
      was = true;
      m.classList.remove('is-open');
      m.querySelector('[data-menu-btn]').setAttribute('aria-expanded', 'false');
    }
    return was;
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu-btn]');
    if (btn && header.contains(btn)) {
      const m = btn.closest('.rd-menu');
      closeAll(m);
      btn.setAttribute('aria-expanded', String(m.classList.toggle('is-open')));
      return;
    }
    if (!e.target.closest('.rd-menu-pop, .rd-nav-drawer, .rd-nav-toggle')) closeAll();
  });

  render();
  return {
    render(next) {
      nav = next || null;
      render();
    },
    setStatus(next) {
      status = next || null;
      renderStatus();
    },
    setTheme(next) {
      theme = next;
      for (const b of header.querySelectorAll('[data-set-theme]')) b.setAttribute('aria-pressed', String(b.dataset.setTheme === theme));
    },
    closeAll: () => closeAll(),
  };
}
