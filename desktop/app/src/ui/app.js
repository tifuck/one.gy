// Native sync panel shell. The panel opens over the website
// (desktop/docs/site-bridge.md) for the account the site page is signed in
// as, and looks like a page of the site: the site's nav (nav.js) on top and
// the admin console layout below (sidebar Syncs / Transfers / Issues /
// Settings, page head, panels), all with the vendored site CSS. It shows only
// what fits this computer's state: the setup when it is not authorized, a
// switch-account guard when it syncs someone else, else the sections.
// Screens are modules exporting mount(container, params) -> unmount().
import { h, icon, svg, clear, field } from './components/dom.js';
import { ICONS } from './components/icons.js';
import { openDialog, confirmDialog } from './components/dialog.js';
import { toast, toastError } from './components/toast.js';
import { manualUpload } from './components/manual.js';
import { createNav } from './nav.js';
import {
  api, rpc, bridge, appSettings, store, on, handleEvent, refreshAll, loadAccount, issueCount, activeTransferCount, sameUser,
} from './store.js';
import * as syncsScreen from './screens/syncs.js';
import * as transfersScreen from './screens/transfers.js';
import * as issuesScreen from './screens/issues.js';
import * as settingsScreen from './screens/settings.js';
import * as wizardScreen from './screens/wizard.js';

const SCREENS = {
  syncs: syncsScreen, transfers: transfersScreen, issues: issuesScreen, settings: settingsScreen, wizard: wizardScreen,
};
const SECTIONS = [
  { id: 'syncs', label: 'Syncs', icon: 'sync' },
  { id: 'transfers', label: 'Transfers', icon: 'transfers', count: activeTransferCount },
  { id: 'issues', label: 'Issues', icon: 'alert', count: issueCount },
  { id: 'settings', label: 'Settings', icon: 'sliders' },
];

const els = {
  panel: document.getElementById('panel'),
  side: document.getElementById('side'),
  content: document.getElementById('admPanel'),
  notice: document.getElementById('notice'),
  screen: document.getElementById('screen'),
};
let current = null; // mounted screen
let mountedGate = null;
let unmount = null;
let wanted = 'syncs'; // the section to show once the panel may show sections

// ready (sections) | setup (authorize this computer) | other (another account) | starting | missing
function gate() {
  if (store.engine === 'missing') return 'missing';
  const a = store.account;
  if (store.engine !== 'connected' || !a) return 'starting';
  if (!a.signed_in) return 'setup';
  if (store.panelUser && !sameUser(a.username, store.panelUser)) return 'other';
  return 'ready';
}

// ---- Router ----------------------------------------------------------------
function go(screen, params = {}) {
  const g = gate();
  let target = screen;
  if (g === 'setup') target = 'wizard';
  else if (g !== 'ready') target = g;
  else if (!SCREENS[target]) target = 'syncs';
  if (SECTIONS.some((s) => s.id === target)) wanted = target;
  if (unmount) { unmount(); unmount = null; }
  current = target;
  mountedGate = g;
  clear(els.screen);
  const mount = SCREENS[target] ? SCREENS[target].mount : MESSAGES[target];
  unmount = mount(els.screen, { ...params, username: store.panelUser }) || null;
  window.scrollTo(0, 0);
  els.content.focus({ preventScroll: true });
  renderSide();
}

// Account or engine changed: leave screens that no longer apply.
function regate() {
  const g = gate();
  // Authorizing in the setup wizard: it goes on to the first sync.
  if (g === mountedGate || (mountedGate === 'setup' && g === 'ready' && current === 'wizard')) {
    mountedGate = g;
    renderSide();
    return;
  }
  go(wanted);
}

// Back to the site page the user came from.
function close() {
  nav.closeAll();
  els.panel.hidden = true;
  api.closePanel();
}

// ---- Screens that are only a message -------------------------------------------
const message = (iconName, title, text, ...actions) => h('div', { class: 'rd-empty' },
  h('span', { class: 'rd-empty-icon' }, icon(iconName)),
  h('h2', { class: 'rd-empty-title' }, title),
  h('p', { class: 'rd-empty-text' }, text),
  actions.length ? h('div', { class: 'dk-btn-row dk-empty-actions' }, actions) : null);

const MESSAGES = {
  starting: (el) => el.append(message('sync', 'Starting the sync engine…', 'This takes a moment after the app starts.')),
  missing: (el) => el.append(message('alert', 'Sync engine not found', 'Reinstall ONE.GY Desktop to fix this.')),
  other: (el) => {
    const mine = store.account.username;
    el.append(message('lock', `This computer syncs ${mine}'s files`,
      `You are signed in on the website as ${store.panelUser}. A computer syncs one account at a time. To sync ${store.panelUser}'s files here, sign out of sync on this computer first. Files on this computer stay where they are.`,
      h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: close }, 'Cancel'),
      h('button', {
        type: 'button', class: 'rd-btn rd-btn-danger',
        onclick: async () => {
          const ok = await confirmDialog({
            title: `Sign out of ${mine}'s sync?`,
            message: `All syncs stop, this computer is removed from ${mine}'s devices and its keys are deleted. Local files are kept.`,
            confirmLabel: 'Sign out of sync', danger: true,
          });
          if (!ok) return;
          try {
            await rpc('account.signOut', { revoke: true });
            await loadAccount();
            toast('Signed out of sync on this computer', 'success');
          } catch (err) {
            toastError(err);
          }
        },
      }, 'Sign out of sync on this computer')));
  },
};

// ---- Nav and sidebar -------------------------------------------------------------
const nav = createNav(document.getElementById('nav'), {
  open: (path) => bridge('openSite', path).catch(toastError),
  theme: (id) => bridge('siteTheme', id).catch(toastError),
  logout: () => bridge('siteLogout').catch(toastError),
});

// The admin console's sidebar (admin.html .adm-side), built once and updated
// in place: status events arrive up to once a second.
const sections = SECTIONS.map((s) => {
  const badge = h('span', { class: 'rd-badge', hidden: true });
  const button = h('button', {
    type: 'button', role: 'tab', class: 'adm-nav-link', 'aria-controls': 'admPanel', onclick: () => go(s.id),
  }, svg(ICONS[s.icon]), s.label, badge);
  els.side.append(button);
  return { s, button, badge };
});
els.notice.append(h('div', { class: 'rd-callout is-warn dk-banner' }, icon('lock'),
  h('div', null, 'Sync is locked. Enter your password to start syncing.'),
  h('button', { type: 'button', class: 'rd-btn rd-btn-primary rd-btn-sm', onclick: () => unlockDialog() }, 'Unlock')));

function renderSide() {
  const ready = mountedGate === 'ready';
  const active = current === 'wizard' ? 'syncs' : current;
  for (const { s, button, badge } of sections) {
    const selected = ready && active === s.id;
    const n = ready && s.count ? s.count() : 0;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.disabled = !ready;
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
  els.notice.hidden = !(ready && ((store.account && store.account.locked) || (store.status && store.status.state === 'locked')));
}

// ---- Global actions ----------------------------------------------------------------
function unlockDialog() {
  const input = h('input', { type: 'password', class: 'form-input', autocomplete: 'current-password' });
  const dlg = openDialog({
    title: 'Unlock sync',
    body: [h('p', null, 'This computer keeps your key in memory only, so it needs your account password after every start.'), field('Password', input)],
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Unlock',
        kind: 'primary',
        run: async () => {
          if (!input.value) throw new Error('Enter your password.');
          try {
            store.account = await rpc('account.unlock', { password: input.value });
          } finally {
            input.value = '';
          }
          renderSide();
        },
      },
    ],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.buttons[1].click(); });
  input.focus();
}

// The site's theme (site preload -> app settings), set before the panel shows.
function applyTheme(theme) {
  const t = theme === 'frost' ? 'frost' : 'frost-dark';
  document.documentElement.dataset.theme = t;
  nav.setTheme(t);
}

// ---- Boot ----------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || els.panel.hidden || document.querySelector('dialog[open], .rd-cmenu')) return;
  if (!nav.closeAll()) close();
});

on('status', renderSide);
on('issues', renderSide);
on('transfers', renderSide);
on('account', regate);
on('engine', regate);
on('app', () => applyTheme(store.app && store.app.theme));
on('app:nav', (d) => nav.render(d));
on('app:siteStatus', (d) => nav.setStatus(d));
on('app:navigate', (d) => (d.screen === 'close' ? close() : go(d.screen, d)));
on('app:panel', (d) => {
  store.panelUser = typeof d.username === 'string' ? d.username : null;
  if (d.theme) applyTheme(d.theme);
  if (d.nav !== undefined) nav.render(d.nav);
  if (d.status) nav.setStatus(d.status);
  els.panel.hidden = false;
  go(d.screen || 'syncs');
  api.panelReady();
});
on('app:action', (d) => {
  if (d.action === 'upload' && gate() === 'ready') manualUpload(d.paths, { useDefault: true });
});

// Dropping files anywhere must never navigate the UI.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function boot() {
  api.onEvent(handleEvent);
  try {
    [store.version, store.app, store.engine] = await Promise.all([bridge('version'), appSettings.get(), bridge('engineState')]);
  } catch (err) {
    toastError(err);
  }
  applyTheme(store.app && store.app.theme);
  if (store.engine === 'connected') await refreshAll();
  go(wanted);
}

boot();
