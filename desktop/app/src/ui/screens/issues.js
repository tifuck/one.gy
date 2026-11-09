// Issues (plan 10.5): grouped by sync and kind, one sentence each, both sides
// side by side, one-click actions. Smart-mode syncs get "Resolve all".
import {
  h, icon, clear, append, pageHead,
} from '../components/dom.js';
import { promptDialog } from '../components/dialog.js';
import { toast, toastError } from '../components/toast.js';
import {
  bytes, dateTime, shortHash, basename, ISSUE_KINDS, ISSUE_ACTIONS,
} from '../components/format.js';
import {
  rpc, bridge, store, on, navigate, loadIssues,
} from '../store.js';

const PRIMARY = new Set(['keep_both', 'retry', 'restore_remote_root']);
const DANGER = new Set(['delete_remote', 'remove_sync']);

function side(label, s) {
  return h('div', { class: 'dk-side' },
    h('div', { class: 'dk-side-label' }, label),
    s ? h('dl', { class: 'dk-side-kv' },
      h('dt', null, 'Size'), h('dd', null, bytes(s.size)),
      s.mtime ? [h('dt', null, 'Modified'), h('dd', null, dateTime(s.mtime))] : null,
      h('dt', null, 'Hash'), h('dd', { class: 'dk-mono' }, shortHash(s.sha256)))
      : h('p', { class: 'dk-side-none' }, 'Not there'));
}

function localPathOf(issue) {
  const sync = store.syncs.get(issue.sync_id);
  if (!sync) return null;
  const sep = sync.local_path.includes('\\') ? '\\' : '/';
  return [sync.local_path.replace(/[\\/]+$/, ''), ...String(issue.path || '').split('/').filter(Boolean)].join(sep);
}

async function resolve(issue, action) {
  try {
    if (action === 'open') {
      const p = localPathOf(issue);
      if (p) await bridge('openPath', p);
      return;
    }
    const params = { id: issue.id, action };
    if (action === 'rename') {
      const name = await promptDialog({ title: 'Rename', label: 'New name', value: basename(issue.path), confirmLabel: 'Rename' });
      if (!name) return;
      params.name = name;
    }
    await rpc('issues.resolve', params);
    store.issues.delete(issue.id);
    toast('Done', 'success');
  } catch (err) {
    toastError(err);
  }
}

// The website's file view has the Versions tab; open the file's folder there.
async function viewVersions(issue) {
  try {
    const v = await rpc('versions.list', { sync_id: issue.sync_id, path: issue.path });
    navigate('close', { path: v.folder_id ? `/files/folder/${v.folder_id}` : '/files' });
  } catch (err) {
    toastError(err);
  }
}

function massDeleteText(issue) {
  const d = issue.detail || {};
  if (!d.count) return null;
  return `${d.count.toLocaleString('en-US')} items were deleted ${d.side === 'remote' ? 'on one.gy' : 'on this computer'}. "Keep" ${d.side === 'remote' ? 'one.gy' : 'this computer'} deletes them on the other side too; the other choice brings them back.`;
}

function issueCard(issue) {
  const showSides = issue.local || issue.remote;
  const versions = issue.kind === 'conflict' && store.account && store.account.versioning;
  const note = issue.kind === 'mass_delete' ? massDeleteText(issue)
    : versions ? 'Previous versions are kept on one.gy.' : null;
  return h('li', { class: 'dk-issue' },
    h('div', { class: 'dk-issue-head' },
      h('span', { class: 'dk-issue-path', title: issue.path }, issue.path || '(sync root)'),
      h('span', { class: 'dk-issue-msg' }, issue.message)),
    showSides ? h('div', { class: 'dk-sides' }, side('This computer', issue.local), side('one.gy', issue.remote)) : null,
    note ? h('p', { class: 'rd-field-hint dk-issue-note' }, icon('info'), note) : null,
    h('div', { class: 'dk-issue-actions' }, (issue.actions || []).filter((a) => ISSUE_ACTIONS[a]).map((a) => h('button', {
      type: 'button',
      class: `rd-btn rd-btn-sm ${PRIMARY.has(a) ? 'rd-btn-primary' : DANGER.has(a) ? 'rd-btn-danger' : 'rd-btn-ghost'}`,
      onclick: (e) => { e.currentTarget.disabled = true; resolve(issue, a).finally(() => render()); },
    }, ISSUE_ACTIONS[a])),
    versions ? h('button', { type: 'button', class: 'rd-btn rd-btn-sm rd-btn-ghost', onclick: () => viewVersions(issue) }, icon('external'), 'View versions on one.gy') : null));
}

let render = () => {};

export function mount(container) {
  const banner = h('div');
  const groups = h('div', { class: 'dk-issue-groups' });
  append(container,
    pageHead('Issues', 'Things the sync engine will not decide on its own. Nothing is deleted while an issue is open.'),
    banner, groups);

  render = () => {
    const issues = [...store.issues.values()];
    clear(banner);
    clear(groups);
    if (!issues.length) {
      append(groups, h('div', { class: 'rd-empty' },
        h('span', { class: 'rd-empty-icon' }, icon('check')),
        h('h2', { class: 'rd-empty-title' }, 'No issues'),
        h('p', { class: 'rd-empty-text' }, 'Everything syncs on its own right now.')));
      return;
    }
    const smart = issues.filter((i) => (store.syncs.get(i.sync_id) || {}).issue_mode !== 'advanced');
    if (smart.length) {
      append(banner, h('div', { class: 'rd-callout is-accent dk-banner' }, icon('info'),
        h('div', null, `${smart.length} issue${smart.length === 1 ? '' : 's'} can be resolved automatically: conflicts keep both copies, nothing is overwritten.`),
        h('button', {
          type: 'button', class: 'rd-btn rd-btn-primary rd-btn-sm',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const res = await rpc('issues.resolveAll', {});
              toast(`${res.resolved} resolved`, 'success');
              await loadIssues();
            } catch (err) {
              toastError(err);
              e.currentTarget.disabled = false;
            }
          },
        }, 'Resolve all automatically')));
    }
    const bySync = new Map();
    for (const i of issues) {
      if (!bySync.has(i.sync_id)) bySync.set(i.sync_id, new Map());
      const kinds = bySync.get(i.sync_id);
      if (!kinds.has(i.kind)) kinds.set(i.kind, []);
      kinds.get(i.kind).push(i);
    }
    for (const [syncId, kinds] of bySync) {
      const sync = store.syncs.get(syncId);
      const section = h('section', { class: 'rd-panel' },
        h('header', { class: 'rd-panel-head' }, h('div', null,
          h('h2', { class: 'rd-panel-title' }, sync ? sync.name : 'Sync'),
          sync ? h('p', { class: 'rd-panel-sub dk-path' }, sync.local_path) : null)));
      const body = h('div', { class: 'rd-panel-body dk-issue-body' });
      for (const [kind, list] of kinds) {
        append(body, h('h3', { class: 'dk-issue-kind' }, ISSUE_KINDS[kind] || kind, h('span', { class: 'rd-pill' }, String(list.length))));
        append(body, h('ul', { class: 'dk-issue-list' }, list.slice(0, 200).map(issueCard)));
      }
      append(section, body);
      append(groups, section);
    }
  };

  render();
  loadIssues().catch(toastError);
  const offs = ['issues', 'account', 'syncs'].map((topic) => on(topic, () => render()));
  return () => offs.forEach((off) => off());
}
