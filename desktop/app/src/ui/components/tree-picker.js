// one.gy folder browser on engine remote.list / remote.createFolder.
// mode 'folder': pick the folder being shown. mode 'items': tick files/folders.
import { h, icon, clear, append } from './dom.js';
import { bytes } from './format.js';
import { promptDialog, openDialog } from './dialog.js';
import { rpc } from '../store.js';

export function treePicker({ mode = 'folder', onChange = () => {}, e2ee = true }) {
  let trail = [{ id: null, name: 'one.gy' }];
  let listing = null;
  let filter = '';
  const ticked = new Map();

  const crumbs = h('nav', { class: 'dk-crumbs', 'aria-label': 'Folder path' });
  const list = h('div', { class: 'dk-tree-list', role: 'list' });
  const status = h('p', { class: 'rd-field-hint', 'aria-live': 'polite' });
  const search = h('input', {
    class: 'form-input dk-tree-search',
    type: 'search',
    placeholder: 'Filter this folder',
    'aria-label': 'Filter this folder',
    oninput: (e) => { filter = e.target.value.trim().toLowerCase(); renderList(); },
  });
  const newFolder = h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: createFolder }, icon('folderPlus'), 'New folder');
  const el = h('div', { class: 'dk-tree' },
    h('div', { class: 'dk-tree-bar' }, crumbs, h('div', { class: 'dk-tree-tools' }, search, mode === 'folder' ? newFolder : null)),
    list, status);

  const current = () => trail[trail.length - 1];
  const pathOf = () => `/${trail.slice(1).map((t) => t.name).join('/')}`;

  function selection() {
    return mode === 'folder'
      ? { id: current().id, path: pathOf() }
      : { ids: [...ticked.keys()], items: [...ticked.values()] };
  }

  async function load(id) {
    status.textContent = 'Loading…';
    clear(list);
    try {
      listing = await rpc('remote.list', { folder_id: id });
      status.textContent = '';
    } catch (err) {
      listing = { folders: [], files: [] };
      status.textContent = err.message;
    }
    renderCrumbs();
    renderList();
    onChange(selection());
  }

  function enter(folder) {
    trail = [...trail, { id: folder.id, name: folder.name }];
    search.value = '';
    filter = '';
    load(folder.id);
  }

  function renderCrumbs() {
    clear(crumbs);
    trail.forEach((t, i) => {
      if (i) append(crumbs, icon('chevronRight', 'dk-crumb-sep'));
      const last = i === trail.length - 1;
      append(crumbs, h('button', {
        type: 'button',
        class: 'dk-crumb',
        'aria-current': last ? 'location' : null,
        disabled: last,
        onclick: () => { trail = trail.slice(0, i + 1); load(t.id); },
      }, t.name));
    });
  }

  function renderList() {
    clear(list);
    if (!listing) return;
    const match = (n) => !filter || String(n.name).toLowerCase().includes(filter);
    const folders = (listing.folders || []).filter(match);
    const files = mode === 'items' ? (listing.files || []).filter(match) : [];
    if (!folders.length && !files.length) {
      append(list, h('p', { class: 'dk-tree-empty' }, filter ? 'Nothing matches.' : 'This folder is empty.'));
      return;
    }
    for (const f of folders) append(list, itemRow(f, true));
    for (const f of files) append(list, itemRow(f, false));
  }

  function itemRow(node, isFolder) {
    const key = `${isFolder ? 'd' : 'f'}:${node.id}`;
    const meta = isFolder ? '' : bytes(node.size_plain ?? node.size);
    const tick = mode === 'items'
      ? h('input', {
        type: 'checkbox',
        'aria-label': `Select ${node.name}`,
        checked: ticked.has(key),
        onchange: (e) => {
          if (e.target.checked) ticked.set(key, { id: node.id, type: isFolder ? 'folder' : 'file', name: node.name });
          else ticked.delete(key);
          onChange(selection());
        },
      })
      : null;
    const open = isFolder
      ? h('button', { type: 'button', class: 'dk-tree-name', onclick: () => enter(node) },
        icon('folder', 'dk-kind-folder'), h('span', null, node.name), node.is_e2e ? icon('lock', 'dk-tree-lock') : null)
      : h('span', { class: 'dk-tree-name' }, icon('file', 'dk-kind-file'), h('span', null, node.name));
    return h('div', { class: 'dk-tree-row', role: 'listitem' }, tick, open,
      h('span', { class: 'dk-tree-meta' }, meta),
      isFolder ? h('button', { type: 'button', class: 'rd-icon-btn', 'aria-label': `Open ${node.name}`, onclick: () => enter(node) }, icon('chevronRight')) : null);
  }

  async function createFolder() {
    const name = await promptDialog({ title: 'New folder', label: 'Folder name', confirmLabel: 'Create' });
    if (!name) return;
    try {
      const folder = await rpc('remote.createFolder', { parent_id: current().id, name, e2ee });
      enter(folder);
    } catch (err) {
      status.textContent = err.message;
    }
  }

  load(null);
  return { el, selection, reload: () => load(current().id) };
}

// Dialog wrapper; resolves the selection or null.
export function pickRemote({ title, mode = 'folder', confirmLabel = 'Choose' }) {
  return new Promise((resolve) => {
    let result = null;
    let sel = null;
    const picker = treePicker({ mode, onChange: (s) => { sel = s; } });
    openDialog({
      title,
      wide: true,
      body: picker.el,
      onClose: () => resolve(result),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        {
          label: confirmLabel,
          kind: 'primary',
          run: () => {
            if (mode === 'items' && (!sel || !sel.ids.length)) throw new Error('Tick at least one item.');
            result = sel;
          },
        },
      ],
    });
  });
}
