// The tray popover (main/tray-popover.js): the account at a glance. Head:
// overall state and speed, pause/resume, upload, close. Left: storage, open
// issues, each sync. Right: transfers running now, then the last finished
// ones. Foot: who and where, Open ONE.GY. It only reads (popover-preload.js);
// everything it does goes to the main process as a tray action.
import { h, icon, fill } from './components/dom.js';
import { openMenu } from './components/menu.js';
import {
  bytes, speed, eta, percent, basename, ago, count, SYNC_TYPES, SYNC_STATES,
} from './components/format.js';
import {
  api, store, on, handleEvent, refreshAll,
} from './store.js';

const tray = window.onegyTray;
const $ = (id) => document.getElementById(id);
const HOUR_MS = 60 * 60 * 1000;
const MAX_LIVE = 4;
const MAX_RECENT = 8;
let pausedUntil = null;
let headKey = null;

const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const syncName = (t) => (t.sync_id && store.syncs.get(t.sync_id) ? store.syncs.get(t.sync_id).name : 'Manual');
const hostOf = (url) => {
  try { return new URL(url).host; } catch { return ''; }
};
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function lastSynced() {
  const times = [...store.syncs.values()].map((s) => s.stats && s.stats.last_synced_at).filter(Boolean).sort();
  if (!store.syncs.size) return 'No syncs set up yet';
  return times.length ? `Last synced ${ago(times[times.length - 1])}` : '';
}

function rates(s) {
  const left = [...store.syncs.values()].reduce((n, x) => n + ((x.stats && x.stats.bytes_left) || 0), 0);
  return [s.bps_up > 0 ? `↑ ${speed(s.bps_up)}` : '', s.bps_down > 0 ? `↓ ${speed(s.bps_down)}` : '', left > 0 ? `${bytes(left)} left` : '']
    .filter(Boolean).join(' · ');
}

// { title, detail, tone } for the head.
function overall() {
  if (store.engine !== 'connected') return { title: store.engine === 'missing' ? 'Sync engine not found' : 'Starting sync engine…', detail: '', tone: '' };
  const s = store.status;
  if (!s) return { title: 'Connecting…', detail: '', tone: '' };
  switch (s.state) {
    case 'syncing': return { title: s.pending ? `Syncing ${plural(s.pending, 'item')}` : 'Syncing', detail: rates(s), tone: 'accent' };
    case 'up_to_date': return { title: 'Up to date', detail: lastSynced(), tone: 'good' };
    case 'paused': return { title: 'Paused', detail: pausedUntil ? `Resumes at ${clock(pausedUntil)}` : 'Until you resume', tone: '' };
    case 'offline': return { title: 'Offline', detail: 'Changes sync when the connection is back.', tone: 'warn' };
    case 'issues': return { title: 'Needs your attention', detail: `${plural(store.issues.size, 'issue')} to review`, tone: 'bad' };
    case 'locked': return { title: 'Locked', detail: 'Unlock ONE.GY to start syncing.', tone: 'warn' };
    default: return { title: 'ONE.GY', detail: '', tone: '' };
  }
}

const iconBtn = (name, label, onclick, disabled) => h('button', {
  type: 'button', class: 'rd-icon-btn', 'aria-label': label, title: label, onclick, disabled,
}, icon(name));

function renderHead() {
  const o = overall();
  $('dot').className = `tp-dot${o.tone ? ` is-${o.tone}` : ''}`;
  $('state').textContent = o.title;
  $('detail').textContent = o.detail;
  $('detail').hidden = !o.detail;
  // Rebuilt only when it changes, so keyboard focus stays put.
  const connected = store.engine === 'connected';
  const paused = Boolean(store.status && store.status.state === 'paused');
  const key = `${connected}:${paused}`;
  if (key === headKey) return;
  headKey = key;
  const pause = paused
    ? iconBtn('play', 'Resume syncing', () => tray.action('resume'), !connected)
    : iconBtn('pause', 'Pause syncing', (e) => openMenu(e.currentTarget, [
      { label: 'Pause for 1 hour', run: () => tray.action('pause', HOUR_MS) },
      { label: 'Pause until resumed', run: () => tray.action('pause', null) },
    ]), !connected);
  fill($('headActions'), pause,
    iconBtn('upload', 'Upload files…', () => tray.action('upload'), !connected),
    iconBtn('x', 'Close', () => tray.action('close')));
}

function renderStorage() {
  const a = store.account;
  if (!a || !a.signed_in) return fill($('storage'));
  const used = a.storage_used || 0;
  const limit = a.storage_limit || 0;
  const pct = percent(used, limit);
  const bar = h('div', { class: `rd-meter-fill${pct >= 95 ? ' is-bad' : pct >= 85 ? ' is-warn' : ''}` });
  bar.style.width = `${pct}%`;
  return fill($('storage'), h('div', { class: 'tp-storage' },
    h('div', { class: 'tp-sec-head' },
      h('h2', { class: 'tp-sec-title' }, 'Storage'),
      limit > 0 ? h('span', { class: 'tp-sec-meta' }, `${bytes(Math.max(0, limit - used))} free`) : null),
    h('p', { class: 'tp-storage-num' }, bytes(used), limit > 0 ? h('span', { class: 'tp-storage-of' }, ` of ${bytes(limit)}`) : h('span', { class: 'tp-storage-of' }, ' used')),
    limit > 0 ? h('div', {
      class: 'rd-meter', role: 'progressbar', 'aria-label': 'Storage used', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100,
    }, bar) : null));
}

function renderIssues() {
  const n = store.issues.size;
  fill($('issues'), n ? h('button', { type: 'button', class: 'tp-issues', onclick: () => tray.action('panel', 'issues') },
    icon('alert'), h('span', null, plural(n, 'issue')), h('span', { class: 'tp-go' }, 'Review')) : null);
}

function stateOf(s) {
  if (s.paused) return SYNC_STATES.paused;
  if (store.account && store.account.locked) return { label: 'Locked', tone: 'warn' };
  return SYNC_STATES[s.state] || { label: s.state, tone: '' };
}

function syncSub(s) {
  const st = s.stats || {};
  const state = stateOf(s);
  const parts = [];
  if (st.pending_up) parts.push(`↑ ${count(st.pending_up)}`);
  if (st.pending_down) parts.push(`↓ ${count(st.pending_down)}`);
  if (st.bytes_left) parts.push(`${bytes(st.bytes_left)} left`);
  if (!parts.length && s.state === 'up_to_date') parts.push(st.last_synced_at ? ago(st.last_synced_at) : 'not synced yet');
  return [
    h('span', { class: `tp-tone${state.tone ? ` is-${state.tone}` : ''}` }, state.label),
    parts.length ? ` · ${parts.join(' · ')}` : '',
    st.issues ? h('span', { class: 'tp-tone is-bad' }, ` · ${plural(st.issues, 'issue')}`) : null,
  ];
}

function renderSyncs() {
  const list = $('syncs');
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const syncs = [...store.syncs.values()].sort((a, b) => a.name.localeCompare(b.name));
  fill(list, syncs.length ? syncs.map((s) => h('li', { class: 'tp-sync' },
    h('button', {
      type: 'button', class: 'tp-sync-main', dataset: { key: `open:${s.id}` }, title: s.local_path, onclick: () => tray.action('panel', 'syncs'),
    },
    icon((SYNC_TYPES[s.type] || SYNC_TYPES.two_way).icon, 'tp-sync-icon'),
    h('span', { class: 'tp-sync-name' }, s.name),
    h('span', { class: 'tp-sync-sub' }, syncSub(s))),
    h('button', {
      type: 'button', class: 'rd-icon-btn tp-sync-folder', dataset: { key: `folder:${s.id}` }, 'aria-label': `Open the ${s.name} folder`, title: 'Open folder',
      onclick: () => tray.action('folder', s.id),
    }, icon('folder'))))
    : h('li', { class: 'tp-none' }, 'No syncs yet. ', h('button', { type: 'button', class: 'tp-link', onclick: () => tray.action('panel', 'syncs') }, 'Add one')));
  const again = focused && list.querySelector(`[data-key="${CSS.escape(focused)}"]`);
  if (again) again.focus();
}

function liveRow(t) {
  const bar = h('div', { class: 'rd-meter-fill' });
  bar.style.width = `${percent(t.done, t.size)}%`;
  const left = eta(t);
  return h('li', { class: 'tp-tr' },
    icon(t.direction === 'up' ? 'upload' : 'download', `tp-tr-icon is-${t.direction}`),
    h('span', { class: 'tp-tr-name', title: t.path }, basename(t.path)),
    h('span', { class: 'tp-tr-meta' }, t.state === 'paused' ? 'Paused' : `${Math.floor(percent(t.done, t.size))}%`),
    h('div', { class: 'rd-meter tp-tr-meter' }, bar),
    h('span', { class: 'tp-tr-sub' }, [`${bytes(t.done)} of ${bytes(t.size)}`, t.bps > 0 ? speed(t.bps) : '', left ? `${left} left` : ''].filter(Boolean).join(' · ')));
}

function doneRow(t) {
  const failed = t.state === 'failed';
  return h('li', { class: 'tp-tr' },
    icon(failed ? 'alert' : 'check', `tp-tr-icon ${failed ? 'is-bad' : 'is-done'}`),
    h('span', { class: 'tp-tr-name', title: t.path }, basename(t.path)),
    h('span', { class: 'tp-tr-meta' }, ago(t.finished_at)),
    failed
      ? h('span', { class: 'tp-tr-sub is-bad', title: t.error || '' }, t.error || 'Failed')
      : h('span', { class: 'tp-tr-sub' }, `${t.direction === 'up' ? 'Uploaded' : 'Downloaded'} · ${bytes(t.size)} · ${syncName(t)}`));
}

// Ties (same second) keep the engine's id order, so rows do not swap between renders.
const newest = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || '')) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

function renderTransfers() {
  const all = [...store.transfers.values()];
  const live = all.filter((t) => t.state === 'active' || t.state === 'paused').sort(newest('started_at'));
  const waiting = all.filter((t) => t.state === 'queued').length + Math.max(0, live.length - MAX_LIVE);
  const recent = all.filter((t) => t.state === 'done' || t.state === 'failed').sort(newest('finished_at')).slice(0, MAX_RECENT);
  if (!live.length && !waiting && !recent.length) {
    return fill($('transfers'), h('div', { class: 'tp-empty' }, icon('transfers'),
      h('p', null, 'Nothing transferring. Files you sync or upload show up here.')));
  }
  return fill($('transfers'),
    live.length || waiting ? [
      h('h3', { class: 'tp-group' }, 'Now'),
      h('ul', { class: 'tp-list' }, live.slice(0, MAX_LIVE).map(liveRow)),
      waiting ? h('p', { class: 'tp-more' }, `${count(waiting)} more in the queue`) : null,
    ] : null,
    recent.length ? [
      h('h3', { class: 'tp-group' }, 'Recently finished'),
      h('ul', { class: 'tp-list' }, recent.map(doneRow)),
    ] : null);
}

function renderFoot() {
  const a = store.account;
  fill($('who'), a && a.signed_in
    ? [h('strong', null, a.username), ` · ${hostOf(a.server)}`, a.device_name ? ` · ${a.device_name}` : '']
    : null);
}

function render() {
  renderHead();
  renderStorage();
  renderIssues();
  renderSyncs();
  renderTransfers();
  renderFoot();
}

// Engine events arrive while hidden too; draw at most once a frame, and only when seen.
let queued = false;
function schedule() {
  if (queued || document.hidden) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    render();
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme === 'frost' ? 'frost' : 'frost-dark';
}

api.onEvent(handleEvent);
for (const topic of ['engine', 'status', 'account', 'syncs', 'transfers', 'issues']) on(topic, schedule);
on('app', (s) => s && setTheme(s.theme));
on('app:tray', (d) => {
  pausedUntil = d && d.pausedUntil;
  schedule();
});

tray.onShow((s) => {
  setTheme(s.theme);
  document.documentElement.dataset.platform = s.platform;
  store.engine = s.engine;
  store.status = s.status;
  pausedUntil = s.pausedUntil;
  render();
  if (s.engine === 'connected') refreshAll().then(render);
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
// "5 min ago" moves on by itself.
setInterval(() => { if (!document.hidden) render(); }, 30 * 1000);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented) tray.action('close'); });
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-panel]');
  if (link) tray.action('panel', link.dataset.panel);
});
$('open').addEventListener('click', () => tray.action('open'));
