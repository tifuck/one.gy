// "What to sync", shared by the wizard and a sync's "Choose what to sync"
// dialog: quick filters, names to skip and a tick-box tree of the folder. All
// of it is .onegyignore text (rules.js); the engine's syncs.browse lists both
// sides and says what that text does to each item, so a tick is what the sync
// really does.
import {
  h, icon, clear, append, fill, row, switchInput, callout,
} from './dom.js';
import { bytes, count } from './format.js';
import { parseRules, buildRules, patternRule } from './rules.js';
import { rpc } from '../store.js';

const LEADS = {
  backup: 'Everything in the folder is backed up. Untick anything you want to leave out.',
  archive: 'Everything in the folder is uploaded. Untick anything you want to leave out.',
  mirror: 'Everything in the one.gy folder is downloaded. Untick what you do not need on this computer.',
  two_way: 'Everything syncs both ways. Untick anything you want to leave out.',
  full: 'Everything on one.gy syncs with this computer. Untick folders you do not need here.',
};

// localPath: the sync root ('' = no local side). remoteFolderId: the one.gy
// root (undefined = no remote side, null = drive root). onChange(text).
export function syncFilter({
  text, type = 'two_way', localPath = '', remoteFolderId, includeHidden = false, onChange = () => {},
}) {
  let rules = text;
  let st = parseRules(rules);
  let trail = [{ name: 'All files', path: '', remoteId: remoteFolderId }];
  let seq = 0;
  let timer = null;
  const hasRemote = remoteFolderId !== undefined;

  const commit = () => {
    rules = buildRules(rules, st);
    area.value = rules;
    onChange(rules);
    renderFilters();
    renderSkipped();
    reload();
  };

  // ---- Quick filters ----------------------------------------------------------
  const filters = h('div', { class: 'dk-opt-group' });
  const sizeInput = h('input', {
    type: 'number', class: 'form-input dk-num', min: 1, max: 1000000, step: 1, 'aria-label': 'Size limit in MB',
    onchange: (e) => {
      st.maxMB = Math.min(1000000, Math.max(1, Math.round(Number(e.target.value)) || 1024));
      commit();
    },
  });
  const nameInput = h('input', {
    class: 'form-input', spellcheck: 'false', placeholder: '*.log, Old drafts, build/', 'aria-label': 'Name or pattern to skip',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addName(); } },
  });
  const chips = h('div', { class: 'dk-chips' });
  function addName() {
    const p = nameInput.value.trim();
    if (!patternRule(p)) return;
    if (!st.patterns.includes(p)) st.patterns.push(p);
    nameInput.value = '';
    commit();
  }
  function renderFilters() {
    sizeInput.value = st.maxMB || 1024;
    sizeInput.disabled = !st.maxMB;
    fill(filters,
      row('Skip system and temporary files', 'Thumbs.db, desktop.ini, .DS_Store, Office lock files and unfinished downloads.',
        switchInput(st.presets.junk, (v) => { st.presets.junk = v; commit(); })),
      row('Skip developer clutter', 'node_modules, Python caches and virtual environments, build caches. Your code and .git stay in.',
        switchInput(st.presets.dev, (v) => { st.presets.dev = v; commit(); })),
      h('div', { class: 'rd-field-row' },
        h('div', { class: 'rd-field-text' },
          h('span', { class: 'rd-field-label' }, 'Skip large files'),
          h('p', { class: 'rd-field-hint' }, 'New files over this size are left out.')),
        h('div', { class: 'dk-btn-row' }, sizeInput, h('span', { class: 'rd-field-hint' }, 'MB'),
          switchInput(Boolean(st.maxMB), (v) => { st.maxMB = v ? (st.maxMB || 1024) : 0; commit(); }))),
      h('div', { class: 'rd-field' },
        h('span', { class: 'rd-field-label' }, 'Skip by name'),
        h('div', { class: 'dk-inline' }, nameInput,
          h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: addName }, icon('plus'), 'Add')),
        h('p', { class: 'rd-field-hint' }, 'A name like Old drafts, or a pattern like *.mp4. End with / to match folders only. Applies in every folder.'),
        chips));
    fill(chips, st.patterns.map((p) => h('span', { class: 'dk-chip' }, h('span', { class: 'dk-path' }, p),
      h('button', {
        type: 'button', class: 'dk-chip-x', 'aria-label': `Stop skipping ${p}`,
        onclick: () => { st.patterns = st.patterns.filter((x) => x !== p); commit(); },
      }, icon('x')))));
  }

  // ---- Tree -------------------------------------------------------------------
  const crumbs = h('nav', { class: 'dk-crumbs', 'aria-label': 'Folder path' });
  const list = h('div', { class: 'dk-tree-list', role: 'list' });
  const status = h('div', { 'aria-live': 'polite' });
  const current = () => trail[trail.length - 1];

  function params(entry) {
    const p = { path: entry.path, ignore_rules: rules, include_hidden_system: includeHidden };
    if (localPath) p.local_path = localPath;
    if (hasRemote && entry.remoteId !== undefined) p.remote_folder_id = entry.remoteId;
    return p;
  }

  function reload() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const res = await rpc('syncs.browse', params(current()));
        if (mine === seq) render(res);
      } catch (err) {
        if (mine === seq) fill(status, callout('bad', 'alert', err.message));
      }
    }, 120);
  }

  function enter(item) {
    trail = [...trail, { name: item.name, path: item.path, remoteId: item.remote_id ?? undefined }];
    clear(list);
    reload();
  }

  async function toggle(item, on) {
    st.skip = st.skip.filter((p) => p !== item.path);
    st.keep = st.keep.filter((p) => p !== item.path);
    if (on) {
      // Back in, but a filter may still leave it out: an exact include wins over filters.
      const probe = await rpc('syncs.browse', { ...params(current()), ignore_rules: buildRules(rules, st) }).catch(() => null);
      const now = probe && probe.items.find((i) => i.path === item.path);
      if (now && (now.excluded || now.size_skipped)) st.keep.push(item.path);
    } else {
      st.skip.push(item.path);
    }
    commit();
  }

  function render(res) {
    clear(crumbs);
    trail.forEach((t, i) => {
      if (i) append(crumbs, icon('chevronRight', 'dk-crumb-sep'));
      const last = i === trail.length - 1;
      append(crumbs, h('button', {
        type: 'button', class: 'dk-crumb', 'aria-current': last ? 'location' : null, disabled: last,
        onclick: () => { trail = trail.slice(0, i + 1); reload(); },
      }, t.name));
    });
    const parentOut = Boolean(res.folder_excluded);
    fill(status,
      (res.errors || []).length ? callout('bad', 'alert', 'The rules have errors, so nothing is left out until they are fixed. See "Edit the rules by hand".') : null,
      parentOut ? callout('warn', 'info', 'This folder is left out, so nothing in it syncs. Tick it again one level up to bring it back.') : null,
      res.more ? h('p', { class: 'rd-field-hint' }, `${count(res.more)} more items are not shown.`) : null);
    clear(list);
    if (!res.items.length) {
      append(list, h('p', { class: 'dk-tree-empty' }, trail.length > 1 ? 'This folder is empty.' : 'Nothing here yet. New files and folders sync automatically.'));
      return;
    }
    for (const it of res.items) append(list, itemRow(it, parentOut));
  }

  function itemRow(it, parentOut) {
    const folder = it.kind === 'folder';
    const out = it.excluded || it.size_skipped;
    const picked = st.skip.includes(it.path);
    let note = folder ? '' : bytes(it.size);
    if (!parentOut && out && !picked) note = it.size_skipped ? 'Too large: skipped' : 'Skipped by a filter';
    else if (hasRemote && localPath && type !== 'backup' && !out) note = [!it.local ? 'on one.gy only' : !it.remote ? 'on this computer only' : '', note].filter(Boolean).join(' · ');
    const tick = h('input', {
      type: 'checkbox', checked: !out, disabled: parentOut, 'aria-label': `Sync ${it.name}`,
      onchange: (e) => toggle(it, e.target.checked),
    });
    const name = folder
      ? h('button', { type: 'button', class: 'dk-tree-name', onclick: () => enter(it) }, icon('folder', 'dk-kind-folder'), h('span', null, it.name))
      : h('label', { class: 'dk-tree-name' }, icon('file', 'dk-kind-file'), h('span', null, it.name));
    if (!folder) name.prepend(tick);
    return h('div', { class: `dk-tree-row${out ? ' is-out' : ''}`, role: 'listitem' },
      folder ? tick : null, name,
      h('span', { class: 'dk-tree-meta' }, note),
      folder ? h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Open ${it.name}`, onclick: () => enter(it) }, icon('chevronRight')) : null);
  }

  // ---- Left out by hand ---------------------------------------------------------
  const skipped = h('div');
  function renderSkipped() {
    if (!st.skip.length) { clear(skipped); return; }
    fill(skipped, h('div', { class: 'rd-field' },
      h('span', { class: 'rd-field-label' }, `Left out (${count(st.skip.length)})`),
      h('div', { class: 'dk-chips' }, st.skip.map((p) => h('span', { class: 'dk-chip' }, h('span', { class: 'dk-path', title: p }, p),
        h('button', {
          type: 'button', class: 'dk-chip-x', 'aria-label': `Sync ${p} again`,
          onclick: () => { st.skip = st.skip.filter((x) => x !== p); commit(); },
        }, icon('x')))))));
  }

  // ---- By hand ----------------------------------------------------------------------
  const area = h('textarea', {
    class: 'form-input is-code dk-rules', rows: 10, spellcheck: 'false', value: rules, 'aria-label': '.onegyignore rules',
    oninput: (e) => {
      rules = e.target.value;
      st = parseRules(rules);
      onChange(rules);
      clearTimeout(timer);
      timer = setTimeout(() => { renderFilters(); renderSkipped(); reload(); }, 300);
    },
  });

  const el = h('div', { class: 'dk-filter' },
    h('p', { class: 'dk-lead' }, LEADS[type] || LEADS.two_way, ' Left-out items are never deleted: they just stay where they are.'),
    h('section', { class: 'dk-tree' },
      h('div', { class: 'dk-tree-bar' }, crumbs),
      list),
    status,
    skipped,
    h('section', { class: 'dk-opt-group' }, h('h3', { class: 'dk-opt-title' }, 'Filters'), filters),
    h('details', { class: 'dk-details' },
      h('summary', null, 'Edit the rules by hand'),
      h('div', { class: 'dk-details-body' },
        h('p', { class: 'rd-field-hint' }, 'The .onegyignore file in the folder, same format as MEGA\'s .megaignore. One rule per line, for example ',
          h('code', null, '-:*.tmp'), ' or ', h('code', null, '-d:node_modules'), '. The app keeps its choices in a block at the end.'),
        area)));
  renderFilters();
  renderSkipped();
  reload();
  return { el, text: () => rules };
}
