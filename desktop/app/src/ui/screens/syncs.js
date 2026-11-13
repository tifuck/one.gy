// Syncs tab (plan 10.3): one row per sync with state, progress and a row
// menu. Dropping a folder onto the screen starts the wizard with it.
import {
  h, icon, clear, append, field, pageHead,
} from '../components/dom.js';
import { openMenu } from '../components/menu.js';
import { openDialog, confirmDialog } from '../components/dialog.js';
import { toast, toastError } from '../components/toast.js';
import { syncOptionsForm } from '../components/sync-options.js';
import { syncFilter } from '../components/sync-filter.js';
import { ACTIONS } from './wizard.js';
import {
  bytes, count, ago, percent, syncPercent, clockTime, SYNC_TYPES, SYNC_STATES,
} from '../components/format.js';
import {
  api, rpc, bridge, store, on, navigate, loadSyncs, loadIssues,
} from '../store.js';

function progressOf(s) {
  const st = s.stats || {};
  const pending = (st.pending_up || 0) + (st.pending_down || 0);
  if (!pending) return null;
  const parts = [];
  if (st.pending_up) parts.push(`${count(st.pending_up)} to upload`);
  if (st.pending_down) parts.push(`${count(st.pending_down)} to download`);
  if (st.bytes_left) parts.push(`${bytes(st.bytes_left)} left`);
  const pct = syncPercent(s);
  if (pct !== null) parts.push(`${Math.floor(pct)}%`);
  return parts;
}

// The bar of a sync with work left: how far it is when the engine gave a
// total, else (an older engine) only that it is busy.
function progressMeter(s) {
  const pct = syncPercent(s);
  const fillEl = h('div', { class: 'rd-meter-fill' });
  if (pct === null) return h('div', { class: 'rd-meter dk-sync-meter is-busy', role: 'progressbar', 'aria-label': 'Syncing' }, fillEl);
  fillEl.style.width = `${pct}%`;
  return h('div', {
    class: 'rd-meter dk-sync-meter', role: 'progressbar', 'aria-label': 'Syncing', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100,
  }, fillEl);
}

function stateOf(s) {
  if (s.paused) return SYNC_STATES.paused;
  // The engine holds every sync while the key is locked; say why.
  if (store.account && store.account.locked) return { label: 'Locked', tone: 'warn' };
  // Work is left but nothing moves right now; the detail line says why.
  if (s.waiting && s.state === 'syncing') return { label: 'Waiting', tone: 'warn' };
  return SYNC_STATES[s.state] || { label: s.state, tone: '' };
}

function syncRow(s) {
  const type = SYNC_TYPES[s.type] || SYNC_TYPES.two_way;
  const state = stateOf(s);
  const progress = progressOf(s);
  const verifying = store.verify.get(s.id);
  const issues = (s.stats && s.stats.issues) || 0;
  const menuBtn = h('button', {
    type: 'button', class: 'rd-icon-btn', 'aria-label': `Actions for ${s.name}`, 'aria-haspopup': 'menu',
    onclick: (e) => openMenu(e.currentTarget, rowMenu(s)),
  }, icon('more'));
  // Why the sync waits or what it is busy with, in the engine's words, in the tone of its state.
  const tone = state.tone === 'warn' || state.tone === 'bad' ? ` is-${state.tone}` : '';
  const detail = s.detail && !s.paused
    ? h('div', { class: `dk-sync-detail${tone}` },
      s.detail, s.retry_at ? ` Next try at ${clockTime(s.retry_at)}.` : '')
    : null;
  let verifyMeter = null;
  if (verifying) {
    const pct = percent(verifying.done, verifying.total);
    const fillEl = h('div', { class: 'rd-meter-fill' });
    fillEl.style.width = `${pct}%`;
    verifyMeter = h('div', { class: 'rd-meter dk-sync-meter', role: 'progressbar', 'aria-label': 'Verifying', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, fillEl);
  }
  const remote = `one.gy${s.remote_path === '/' ? '' : s.remote_path}`;
  const synced = s.stats && s.stats.last_synced_at;
  return h('li', { class: 'dk-sync' },
    h('span', { class: `dk-sync-icon${s.encryption === 'e2ee' ? ' is-e2ee' : ''}`, title: type.label }, icon(type.icon)),
    h('div', { class: 'dk-sync-main' },
      h('span', { class: 'dk-sync-name', title: s.name }, s.name),
      h('div', { class: 'dk-sync-paths' },
        h('span', { class: 'dk-path', title: s.local_path }, s.local_path),
        icon(s.type === 'mirror' ? 'arrowLeft' : s.type === 'two_way' || s.type === 'full' ? 'arrowBoth' : 'arrowRight', 'dk-sync-arrow'),
        h('span', { class: 'dk-path', title: remote }, remote)),
      verifyMeter || (progress && !s.paused ? progressMeter(s) : null),
      h('div', { class: 'dk-sync-meta' },
        h('span', null, type.short),
        s.encryption === 'standard' ? h('span', { class: 'is-warn', title: 'Not end-to-end encrypted' }, 'Standard encryption') : null,
        verifying ? h('span', null, `Verifying ${count(verifying.done)} of ${count(verifying.total)} files`) : null,
        progress ? progress.map((p) => h('span', null, p)) : h('span', null, synced ? `Last synced ${ago(synced)}` : 'Not synced yet')),
      detail),
    h('div', { class: 'dk-sync-status' },
      issues ? h('button', { type: 'button', class: 'rd-pill is-bad dk-pill-btn', onclick: () => navigate('issues') }, `${issues} issue${issues === 1 ? '' : 's'}`) : null,
      h('span', { class: `rd-pill is-dot${state.tone ? ` is-${state.tone}` : ''}` }, state.label)),
    h('div', { class: 'dk-sync-actions' },
      h('button', {
        type: 'button', class: 'rd-icon-btn', 'aria-label': s.paused ? `Resume ${s.name}` : `Pause ${s.name}`,
        onclick: () => togglePause(s),
      }, icon(s.paused ? 'play' : 'pause')),
      menuBtn));
}

const run = (promise, done) => promise.then((r) => { if (done) toast(done, 'success'); return r; }).catch(toastError);

function togglePause(s) {
  run(rpc(s.paused ? 'syncs.resume' : 'syncs.pause', { id: s.id }));
}

function rowMenu(s) {
  return [
    { label: s.paused ? 'Resume' : 'Pause', icon: s.paused ? 'play' : 'pause', run: () => togglePause(s) },
    { label: 'Sync now', icon: 'sync', run: () => run(rpc('syncs.syncNow', { id: s.id }), 'Sync started') },
    { label: 'Verify now', icon: 'shield', run: () => verify(s) },
    'sep',
    { label: 'Open folder', icon: 'folder', run: () => run(bridge('openPath', s.local_path)) },
    { label: 'Open on one.gy', icon: 'external', run: () => navigate('close', { path: s.remote_folder_id ? `/files/folder/${s.remote_folder_id}` : '/files' }) },
    'sep',
    { label: 'Choose what to sync', icon: 'sliders', run: () => whatToSyncDialog(s) },
    { label: 'Settings', icon: 'settings', run: () => settingsDialog(s) },
    { label: 'Open deleted files', icon: 'trash', run: () => run(bridge('openPath', joinLocal(s.local_path, '.onegy', 'debris'))) },
    'sep',
    { label: 'Remove sync', icon: 'x', danger: true, run: () => removeSync(s) },
  ];
}

function joinLocal(root, ...parts) {
  const sep = root.includes('\\') ? '\\' : '/';
  return [root.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

async function verify(s) {
  toast(`Checking ${s.name}…`);
  const res = await rpc('syncs.verify', { id: s.id }).catch(toastError);
  if (!res) return;
  const bad = (res.differs || 0) + (res.missing || 0);
  toast(bad ? `${count(res.differs)} differ and ${count(res.missing)} are missing. See Issues.` : `All ${count(res.matches)} files match.`, bad ? 'error' : 'success', 6000);
}

function settingsDialog(s) {
  const patch = JSON.parse(JSON.stringify(s));
  const fixed = h('div', { class: 'dk-kv' },
    h('span', null, 'Type'), h('span', null, (SYNC_TYPES[s.type] || {}).label || s.type),
    h('span', null, 'This computer'), h('span', { class: 'dk-path' }, s.local_path),
    h('span', null, 'On one.gy'), h('span', { class: 'dk-path' }, `one.gy${s.remote_path === '/' ? '' : s.remote_path}`),
    h('span', null, 'Encryption'), h('span', null, s.encryption === 'e2ee' ? 'End-to-end encrypted' : 'Standard encryption'));
  const name = h('input', { class: 'form-input', value: s.name, maxlength: 80 });
  openDialog({
    title: `Settings for ${s.name}`,
    wide: true,
    body: [
      fixed,
      h('p', { class: 'rd-field-hint' }, 'The folders, type and encryption can’t be changed. To change them, remove the sync and add it again.'),
      field('Name', name),
      syncOptionsForm(patch, { platform: store.version && store.version.platform }),
    ],
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Save',
        kind: 'primary',
        run: async () => {
          const keys = ['conflict_policy', 'issue_mode', 'propagate_deletes', 'debris_days', 'schedule', 'limits', 'metered', 'battery', 'keep_exec_bit', 'include_hidden_system', 'thumbnails'];
          const changes = { name: name.value.trim() || s.name };
          for (const k of keys) if (JSON.stringify(patch[k]) !== JSON.stringify(s[k])) changes[k] = patch[k];
          const updated = await rpc('syncs.update', { id: s.id, patch: changes });
          store.syncs.set(updated.id, updated);
          toast('Settings saved', 'success');
        },
      },
    ],
  });
}

// The sync's .onegyignore as ticks and filters (components/sync-filter.js).
async function whatToSyncDialog(s) {
  let text = '';
  try {
    ({ text } = await rpc('syncs.ignoreRules', { id: s.id }));
  } catch (err) {
    toastError(err);
    return;
  }
  const filter = syncFilter({
    text,
    type: s.type,
    localPath: s.type === 'mirror' ? '' : s.local_path,
    remoteFolderId: ['backup', 'archive'].includes(s.type) ? undefined : (s.remote_folder_id ?? null),
    includeHidden: s.include_hidden_system,
  });
  openDialog({
    title: `What to sync in ${s.name}`,
    wide: true,
    body: filter.el,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Save',
        kind: 'primary',
        run: async () => {
          if (filter.text() === text) return;
          const res = await rpc('syncs.setIgnoreRules', { id: s.id, text: filter.text() });
          if (!res.ok) throw new Error((res.errors || []).map((e) => `Line ${e.line}: ${e.message}`).join(' '));
          toast('Saved. The sync applies the change now.', 'success');
        },
      },
    ],
  });
}

async function removeSync(s) {
  const backup = s.type === 'backup';
  const alsoLocal = h('input', { type: 'checkbox' });
  let release = false;
  const backupChoice = backup ? h('div', { class: 'dk-radio-list', role: 'radiogroup', 'aria-label': 'The copy on one.gy' },
    [[false, 'Leave it as a read-only backup', 'Nothing on one.gy can change it until you stop it in Devices on the website.'],
      [true, 'Make it a normal folder', 'You and your other devices can edit it again.']].map(([value, label, text]) => h('label', { class: 'dk-radio' },
      h('input', { type: 'radio', name: 'release', checked: value === release, onchange: () => { release = value; } }),
      h('span', null, h('strong', null, label), h('span', { class: 'rd-field-hint' }, text))))) : null;
  const ok = await confirmDialog({
    title: `Remove ${s.name}?`,
    message: backup ? 'Backing up stops. Files stay on this computer and on one.gy.' : 'Syncing stops. Files stay on this computer and on one.gy.',
    confirmLabel: 'Remove sync',
    danger: true,
    extra: h('div', { class: 'dk-form' }, backupChoice,
      h('label', { class: 'rd-check' }, alsoLocal, 'Also move the folder on this computer to the system trash')),
  });
  if (!ok) return;
  if (alsoLocal.checked) {
    const sure = await confirmDialog({
      title: 'Move the local folder to the trash?',
      message: `${s.local_path} and everything in it go to the system trash. The copy on one.gy stays.`,
      confirmLabel: 'Move to trash',
      danger: true,
      requireText: s.name,
    });
    if (!sure) return;
  }
  await run(bridge('removeSync', s.id, { deleteLocal: alsoLocal.checked, releaseBackup: release }),
    alsoLocal.checked ? 'Sync removed and folder moved to the trash' : 'Sync removed');
  loadSyncs().catch(toastError);
  loadIssues().catch(toastError);
}

export function mount(container) {
  const list = h('div');
  const page = h('div', { class: 'dk-drop' },
    pageHead('Syncs', 'Folders on this computer that stay in sync with one.gy.',
      h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => navigate('wizard', { type: 'backup' }) }, icon('backup'), 'Add backup'),
      h('button', { type: 'button', class: 'rd-btn rd-btn-primary', onclick: () => navigate('wizard', {}) }, icon('plus'), 'Add sync')),
    list,
    h('p', { class: 'dk-drop-hint' }, 'Drop a folder here to add a sync.'));

  function render() {
    clear(list);
    const syncs = [...store.syncs.values()].sort((x, y) => String(x.name).localeCompare(String(y.name)));
    if (!syncs.length) {
      append(list, h('div', { class: 'rd-empty' },
        h('span', { class: 'rd-empty-icon' }, icon('sync')),
        h('h2', { class: 'rd-empty-title' }, 'No syncs yet'),
        h('p', { class: 'rd-empty-text' }, 'Choose what this computer should do. You can add more later.'),
        h('div', { class: 'dk-cards dk-empty-cards' }, ACTIONS.filter((a) => a.type).map((a) => h('button', {
          type: 'button', class: 'dk-card', onclick: () => navigate('wizard', { type: a.type }),
        }, h('span', { class: 'dk-card-icon' }, icon(SYNC_TYPES[a.type].icon)),
        h('span', { class: 'dk-card-title' }, a.title), h('span', { class: 'dk-card-text' }, a.text))))));
      return;
    }
    append(list, h('section', { class: 'rd-panel' }, h('ul', { class: 'dk-sync-list' }, syncs.map(syncRow))));
  }

  page.addEventListener('dragover', (e) => { e.preventDefault(); page.classList.add('is-dragover'); });
  page.addEventListener('dragleave', (e) => { if (!page.contains(e.relatedTarget)) page.classList.remove('is-dragover'); });
  page.addEventListener('drop', (e) => {
    e.preventDefault();
    page.classList.remove('is-dragover');
    const file = e.dataTransfer && e.dataTransfer.files[0];
    const localPath = file ? api.pathForFile(file) : null;
    if (localPath) navigate('wizard', { localPath });
  });

  append(container, page);
  render();
  const offs = [on('syncs', render), on('account', render), on('verify', render)];
  return () => offs.forEach((off) => off());
}
