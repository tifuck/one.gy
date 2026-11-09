// Native UI shell: rail, router, site toolbar, status bar, global actions.
// Screens are modules exporting mount(container, params) -> unmount().
import { h, icon, clear, fill, field } from './components/dom.js';
import { openDialog } from './components/dialog.js';
import { toastError } from './components/toast.js';
import { manualUpload, manualDownload } from './components/manual.js';
import { bytes, speed } from './components/format.js';
import {
  api, rpc, bridge, appSettings, store, on, handleEvent, refreshAll, loadAccount, issueCount, activeTransferCount,
} from './store.js';
import * as syncsScreen from './screens/syncs.js';
import * as transfersScreen from './screens/transfers.js';
import * as issuesScreen from './screens/issues.js';
import * as settingsScreen from './screens/settings.js';
import * as wizardScreen from './screens/wizard.js';

const SITE_SCREENS = new Set(['files', 'notes', 'music', 'web']);
const NATIVE = {
  sync: syncsScreen, transfers: transfersScreen, issues: issuesScreen, settings: settingsScreen, wizard: wizardScreen,
};
const RAIL = [
  [{ id: 'files', label: 'Files', icon: 'files' }, { id: 'notes', label: 'Notes', icon: 'notes' }, { id: 'music', label: 'Music', icon: 'music' }],
  [{ id: 'sync', label: 'Sync', icon: 'sync' }, { id: 'transfers', label: 'Transfers', icon: 'transfers', badge: activeTransferCount },
    { id: 'issues', label: 'Issues', icon: 'issues', badge: issueCount, tone: 'bad' }],
  [{ id: 'settings', label: 'Settings', icon: 'settings' }],
];

const els = {
  rail: document.getElementById('rail'),
  sitebar: document.getElementById('sitebar'),
  slot: document.getElementById('siteSlot'),
  screen: document.getElementById('screen'),
  status: document.getElementById('statusbar'),
};
let current = null;
let unmount = null;

// ---- Router ----------------------------------------------------------------
function go(screen, params = {}) {
  const site = SITE_SCREENS.has(screen);
  if (!site && !NATIVE[screen]) return;
  const reset = site && current === screen && params.reset !== false;
  if (unmount) { unmount(); unmount = null; }
  current = screen;
  els.sitebar.hidden = !site;
  els.slot.hidden = !site;
  els.screen.hidden = site;
  clear(els.screen);
  if (!site) {
    unmount = NATIVE[screen].mount(els.screen, params) || null;
    els.screen.focus({ preventScroll: true });
  }
  api.view(screen, reset);
  if (site) reportSlot();
  renderRail();
}

// ---- Site view slot ------------------------------------------------------------
function reportSlot() {
  if (els.slot.hidden) return;
  const r = els.slot.getBoundingClientRect();
  api.siteBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
new ResizeObserver(reportSlot).observe(els.slot);
window.addEventListener('resize', reportSlot);

function renderSitebar() {
  const s = store.site || {};
  let where = '';
  try { const u = new URL(s.url); where = `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { /* blank */ }
  fill(els.sitebar, 
    h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': 'Back', disabled: !s.canGoBack, onclick: () => api.siteNav('back') }, icon('back')),
    h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': 'Forward', disabled: !s.canGoForward, onclick: () => api.siteNav('forward') }, icon('forward')),
    h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': 'Reload', onclick: () => api.siteNav('reload') }, icon('reload')),
    h('span', { class: 'dk-sitebar-where', title: s.url || '' }, s.error || where),
    s.loading ? h('span', { class: 'dk-sitebar-loading', 'aria-label': 'Loading' }) : null,
  );
  els.sitebar.classList.toggle('is-error', Boolean(s.error));
}

// ---- Rail ----------------------------------------------------------------------
function renderRail() {
  const groups = RAIL.map((group) => h('div', { class: 'dk-rail-group' }, group.map((item) => {
    const n = item.badge ? item.badge() : 0;
    const active = current === item.id || (current === 'wizard' && item.id === 'sync');
    return h('button', {
      type: 'button',
      class: `dk-rail-item${active ? ' is-active' : ''}`,
      'aria-current': active ? 'page' : null,
      onclick: () => go(item.id),
    }, icon(item.icon), h('span', { class: 'dk-rail-label' }, item.label),
    n ? h('span', { class: `dk-rail-badge${item.tone ? ` is-${item.tone}` : ''}`, 'aria-label': `${n} pending` }, n > 99 ? '99+' : String(n)) : null);
  })));
  fill(els.rail, 
    h('div', { class: 'dk-rail-brand', title: 'ONE.GY Desktop' }, icon('lock')),
    groups[0], groups[1], h('div', { class: 'dk-rail-spacer' }), groups[2]);
}

// ---- Status bar ------------------------------------------------------------------
function statusText() {
  if (store.engine === 'missing') return { text: 'Sync engine not found. Reinstall the app to fix this.', tone: 'bad' };
  if (store.engine !== 'connected') return { text: 'Starting sync engine…', tone: '' };
  const s = store.status;
  const a = store.account;
  if (a && !a.signed_in) return { text: 'Sync is not set up on this computer', tone: '', action: ['Set up', () => go('wizard')] };
  if ((s && s.state === 'locked') || (a && a.locked)) return { text: 'Locked. Enter your password to sync.', tone: 'warn', action: ['Unlock', unlockDialog] };
  if (!s) return { text: 'Connecting…', tone: '' };
  switch (s.state) {
    case 'up_to_date': return { text: 'Up to date', tone: 'good' };
    case 'syncing': return { text: s.pending ? `Syncing ${s.pending.toLocaleString('en-US')} item${s.pending === 1 ? '' : 's'}` : 'Syncing', tone: 'accent' };
    case 'paused': return { text: 'Paused', tone: '', action: ['Resume', () => rpc('syncs.resume', {}).catch(toastError)] };
    case 'offline': return { text: 'Offline. Changes sync when the connection is back.', tone: 'warn' };
    case 'issues': return { text: issueCount() === 1 ? '1 issue needs you' : `${issueCount() || 'Some'} issues need you`, tone: 'bad', action: ['Review', () => go('issues')] };
    case 'signed_out': return { text: 'Signed out', tone: '', action: ['Set up', () => go('wizard')] };
    default: return { text: s.state, tone: '' };
  }
}

function renderStatus() {
  const st = statusText();
  const s = store.status;
  const rates = s && (s.bps_up > 0 || s.bps_down > 0)
    ? h('span', { class: 'dk-status-rates' }, s.bps_up > 0 ? `↑ ${speed(s.bps_up)}` : '', s.bps_down > 0 ? ` ↓ ${speed(s.bps_down)}` : '')
    : null;
  const a = store.account;
  const quota = a && a.signed_in && a.storage_limit > 0 ? h('span', { class: 'dk-status-quota' }, `${bytes(a.storage_used)} of ${bytes(a.storage_limit)}`) : null;
  fill(els.status, 
    h('span', { class: `dk-status-dot${st.tone ? ` is-${st.tone}` : ''}` }),
    h('span', { class: 'dk-status-text' }, st.text),
    st.action ? h('button', { type: 'button', class: 'dk-status-action', onclick: st.action[1] }, st.action[0]) : null,
    h('span', { class: 'dk-status-spacer' }),
    rates, quota);
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
          store.account = await rpc('account.unlock', { password: input.value });
          input.value = '';
          renderStatus();
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
on('status', () => { renderStatus(); renderRail(); });
on('account', renderStatus);
on('engine', renderStatus);
on('issues', () => { renderRail(); renderStatus(); });
on('transfers', renderRail);
on('app', applyTheme);
on('site', () => {
  renderSitebar();
  const section = store.site.section;
  if (SITE_SCREENS.has(current) && section && section !== current) { current = section; renderRail(); }
});
on('app:navigate', (d) => go(d.screen, { reset: false, ...d }));
on('app:action', (d) => {
  if (d.action === 'upload') manualUpload(d.paths, { useDefault: true });
  if (d.action === 'download') manualDownload();
});

// Dropping files anywhere must never navigate the UI.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

const waitForEngine = (ms) => new Promise((resolve) => {
  if (store.engine === 'connected') { resolve(); return; }
  const off = on('engine', (s) => { if (s === 'connected') { off(); resolve(); } });
  setTimeout(() => { off(); resolve(); }, ms);
});

async function boot() {
  api.onEvent(handleEvent);
  try {
    [store.version, store.app, store.engine] = await Promise.all([bridge('version'), appSettings.get(), bridge('engineState')]);
  } catch (err) {
    toastError(err);
  }
  applyTheme();
  renderRail();
  renderStatus();
  renderSitebar();
  if (store.engine === 'connected') await refreshAll();
  await waitForEngine(4000);
  if (store.engine === 'connected' && !store.account) await loadAccount().catch(() => {});
  go(store.account && store.account.signed_in === false ? 'wizard' : 'files');
}

boot();
