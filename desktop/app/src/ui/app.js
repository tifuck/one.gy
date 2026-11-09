// Native sync panel shell. The panel opens over the website
// (desktop/docs/site-bridge.md) for the account the site page is signed in
// as, and shows only what fits this computer's state: the setup when it is
// not authorized, a switch-account guard when it syncs someone else, else the
// tabs. Screens are modules exporting mount(container, params) -> unmount().
import { h, icon, clear, fill, field } from './components/dom.js';
import { openDialog, confirmDialog } from './components/dialog.js';
import { toast, toastError } from './components/toast.js';
import { manualUpload } from './components/manual.js';
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
const TABS = [
  { id: 'syncs', label: 'Syncs' },
  { id: 'transfers', label: 'Transfers', count: activeTransferCount },
  { id: 'issues', label: 'Issues', count: issueCount },
  { id: 'settings', label: 'Settings' },
];

const els = {
  panel: document.getElementById('panel'),
  tabs: document.getElementById('tabs'),
  status: document.getElementById('status'),
  close: document.getElementById('close'),
  notice: document.getElementById('notice'),
  screen: document.getElementById('screen'),
};
let current = null; // mounted screen
let mountedGate = null;
let unmount = null;
let wanted = 'syncs'; // the tab to show once the panel may show tabs

// ready (tabs) | setup (authorize this computer) | other (another account) | starting | missing
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
  if (TABS.some((t) => t.id === target)) wanted = target;
  if (unmount) { unmount(); unmount = null; }
  current = target;
  mountedGate = g;
  clear(els.screen);
  const mount = SCREENS[target] ? SCREENS[target].mount : MESSAGES[target];
  unmount = mount(els.screen, { ...params, username: store.panelUser }) || null;
  els.screen.scrollTop = 0;
  els.screen.focus({ preventScroll: true });
  renderHead();
}

// Account or engine changed: leave screens that no longer apply.
function regate() {
  const g = gate();
  // Authorizing in the setup wizard: it goes on to the first sync.
  if (g === mountedGate || (mountedGate === 'setup' && g === 'ready' && current === 'wizard')) {
    mountedGate = g;
    renderHead();
    return;
  }
  go(wanted);
}

function close() {
  els.panel.hidden = true;
  api.closePanel();
}

// ---- Screens that are only a message -------------------------------------------
const message = (iconName, title, text, ...actions) => h('div', { class: 'rd-page' },
  h('div', { class: 'rd-empty' },
    h('span', { class: 'rd-empty-icon' }, icon(iconName)),
    h('h2', { class: 'rd-empty-title' }, title),
    h('p', { class: 'rd-empty-text' }, text),
    actions.length ? h('div', { class: 'dk-btn-row dk-empty-actions' }, actions) : null));

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

// ---- Header ------------------------------------------------------------------
function statusPill() {
  const s = store.status;
  if (!s) return null;
  const n = issueCount();
  const [text, tone] = {
    up_to_date: ['Up to date', 'good'],
    syncing: [s.pending ? `Syncing ${s.pending.toLocaleString('en-US')} item${s.pending === 1 ? '' : 's'}` : 'Syncing', 'accent'],
    paused: ['Paused', ''],
    offline: ['Offline', 'warn'],
    issues: [n === 1 ? '1 issue' : `${n || 'Some'} issues`, 'bad'],
    locked: ['Locked', 'warn'],
  }[s.state] || [];
  return text ? h('span', { class: `rd-pill is-dot${tone ? ` is-${tone}` : ''}` }, text) : null;
}

// Built once and updated in place: status events arrive up to once a second.
const tabs = TABS.map((t) => {
  const count = h('span', { class: 'rd-count', hidden: true });
  const button = h('button', { type: 'button', role: 'tab', class: 'rd-tab', onclick: () => go(t.id) }, t.label, count);
  els.tabs.append(button);
  return { t, button, count };
});
els.notice.append(h('div', { class: 'rd-callout is-warn dk-banner' }, icon('lock'),
  h('div', null, 'Sync is locked. Enter your password to start syncing.'),
  h('button', { type: 'button', class: 'rd-btn rd-btn-primary rd-btn-sm', onclick: () => unlockDialog() }, 'Unlock')));

function renderHead() {
  const ready = mountedGate === 'ready';
  els.tabs.hidden = !ready;
  const active = current === 'wizard' ? 'syncs' : current;
  for (const { t, button, count } of tabs) {
    const n = t.count ? t.count() : 0;
    button.setAttribute('aria-selected', String(active === t.id));
    count.hidden = !n;
    count.textContent = n > 99 ? '99+' : String(n);
  }
  fill(els.status, ready ? statusPill() : null);
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
          renderHead();
        },
      },
    ],
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.buttons[1].click(); });
  input.focus();
}

function applyTheme() {
  document.documentElement.dataset.theme = (store.app && store.app.theme) || 'frost-dark';
}

// ---- Boot ----------------------------------------------------------------------------
els.close.append(icon('x'));
els.close.addEventListener('click', close);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || els.panel.hidden || document.querySelector('dialog[open], .rd-cmenu')) return;
  close();
});

on('status', renderHead);
on('issues', renderHead);
on('transfers', renderHead);
on('account', regate);
on('engine', regate);
on('app', applyTheme);
on('app:navigate', (d) => (d.screen === 'close' ? close() : go(d.screen, d)));
on('app:panel', (d) => {
  store.panelUser = typeof d.username === 'string' ? d.username : null;
  els.panel.hidden = false;
  go(d.screen || 'syncs');
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
  applyTheme();
  if (store.engine === 'connected') await refreshAll();
  go(wanted);
}

boot();
