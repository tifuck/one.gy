// Setup wizard (plan 10.2): set up sync on this computer (authorize it for the
// account the website is signed in as: params.username, locked), then what to
// do, local folder, one.gy folder, options, preview, start. The steps after
// the setup also run from "Add sync" / "Add backup" / dropping a folder on
// the Syncs screen.
import {
  h, icon, clear, append, fill, field, row, switchInput, callout, pageHead,
} from '../components/dom.js';
import { treePicker } from '../components/tree-picker.js';
import { pinFields, pinRules, pinSummary } from '../components/pin.js';
import { syncOptionsForm, newSyncConfig, DEFAULT_IGNORE_RULES } from '../components/sync-options.js';
import { toast } from '../components/toast.js';
import {
  bytes, count, basename, SYNC_TYPES,
} from '../components/format.js';
import {
  rpc, bridge, store, navigate, loadAccount, loadSyncs, sameUser,
} from '../store.js';

const DEFAULT_SERVER = 'https://one.gy';

const ACTIONS = [
  { type: 'two_way', title: 'Sync a folder', text: 'Changes on this computer and on one.gy show up on both sides.' },
  { type: 'backup', title: 'Back up a folder', text: 'Copies this computer to one.gy. The copy on one.gy is read-only.' },
  { type: 'mirror', title: 'Mirror a one.gy folder here', text: 'Downloads a one.gy folder and keeps it updated. Local edits are undone.' },
  { type: 'full', title: 'Sync my whole drive', text: 'Two-way sync of everything on one.gy. Cannot be combined with other syncs.' },
  { type: null, title: 'Skip for now', text: 'Go to your files. Add syncs later from Sync.' },
];

export const AUTH_ERRORS = {
  invalid_credentials: 'Wrong username or password.',
  invalid_totp: 'That code did not work. Check the time on this computer and try again.',
  captcha_required: 'Too many attempts. Wait a few minutes, then try again.',
  device_revoked: 'This computer was removed from your account. Authorize it again.',
  offline: 'Could not reach the server. Check your connection.',
};

const INITIAL = [
  ['merge', 'Merge', 'Keep everything from both sides. Files that differ are kept as two copies.'],
  ['local_source', 'This computer is the source', 'one.gy is made to match this computer. Replaced files go to one.gy trash or versions.'],
  ['remote_source', 'one.gy is the source', 'This computer is made to match one.gy. Replaced files go to the local debris folder.'],
];

function messageList(kind, items) {
  if (!items || !items.length) return null;
  return callout(kind, kind === 'bad' ? 'alert' : 'info',
    h('ul', { class: 'dk-msg-list' }, items.map((m) => h('li', null, typeof m === 'string' ? m : m.message))));
}

export function mount(container, params = {}) {
  const platform = (store.version && store.version.platform) || 'linux';
  const w = {
    cfg: newSyncConfig((store.settings && store.settings.defaults) || {}, platform),
    ignoreText: DEFAULT_IGNORE_RULES,
    initial: 'merge',
    validation: null,
    preview: null,
    standardConfirm: '',
    showTotp: false,
    backupCustom: false,
    nameTouched: false,
  };
  if (params.type) w.cfg.type = params.type;
  if (params.localPath) w.cfg.local_path = params.localPath;

  const signedIn = () => Boolean(store.account && store.account.signed_in && !store.account.locked);
  const STEPS = [
    { id: 'authorize', setup: true, render: stepAuthorize },
    { id: 'pin', setup: true, render: stepPin },
    { id: 'action', render: stepAction },
    { id: 'local', render: stepLocal },
    { id: 'remote', render: stepRemote },
    { id: 'options', render: stepOptions },
    { id: 'preview', render: stepPreview },
  ];
  // onboarding: right after the app's sign-in (signin.js): the PIN, then what to sync.
  const visible = () => STEPS.filter((s) => !(s.setup && fromSyncScreen) && !(params.onboarding && s.id === 'authorize'));
  const fromSyncScreen = signedIn() && !params.onboarding;
  let index = 0;
  if (fromSyncScreen) index = visible().findIndex((s) => s.id === (params.type ? 'local' : 'action'));

  const title = h('h2', { class: 'rd-panel-title dk-step-title', tabindex: '-1' });
  const stepOf = h('p', { class: 'rd-panel-sub' });
  const content = h('div', { class: 'dk-step-body' });
  const error = h('p', { class: 'rd-field-error', role: 'alert' });
  const backBtn = h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => go(index - 1) }, 'Back');
  const nextBtn = h('button', { type: 'button', class: 'rd-btn rd-btn-primary', onclick: () => next() }, 'Continue');
  const cancelBtn = h('button', {
    type: 'button', class: 'rd-btn rd-btn-ghost dk-step-cancel',
    onclick: () => navigate(signedIn() && !params.onboarding ? 'syncs' : 'close'),
  }, 'Cancel');
  let onNext = async () => true;

  append(container, h('div', { class: 'adm-narrow' },
    fromSyncScreen
      ? pageHead(params.type === 'backup' ? 'New backup' : 'New sync', 'Pick the folders, then check what will happen before anything moves.')
      : params.onboarding
        ? pageHead(`Welcome, ${(store.account && store.account.username) || 'back'}`, 'A few choices for this computer. Skip any of them and change them later in Sync.')
        : pageHead('Set up sync on this computer', 'Authorize this computer once, then choose what to sync.'),
    h('section', { class: 'rd-panel' },
      h('header', { class: 'rd-panel-head' }, h('div', null, title, stepOf)),
      h('div', { class: 'rd-panel-body' }, content, error),
      h('footer', { class: 'rd-panel-foot' }, cancelBtn, h('span', { class: 'dk-spacer' }), backBtn, nextBtn))));

  const setReady = (ready, label) => {
    nextBtn.disabled = !ready;
    if (label) nextBtn.textContent = label;
  };

  function go(i) {
    const steps = visible();
    index = Math.max(0, Math.min(steps.length - 1, i));
    const step = steps[index];
    clear(content);
    error.textContent = '';
    backBtn.hidden = index === 0;
    setReady(true, 'Continue');
    onNext = async () => true;
    stepOf.textContent = `Step ${index + 1} of ${steps.length}`;
    step.render();
    title.focus({ preventScroll: true });
  }

  async function next() {
    error.textContent = '';
    setReady(false);
    try {
      if (await onNext()) go(index + 1);
      else setReady(true);
    } catch (err) {
      error.textContent = err.message;
      setReady(true);
    }
  }

  // ---- 1. Set up sync on this computer: authorize it ------------------------
  function stepAuthorize() {
    const a = store.account || {};
    if (a.signed_in && a.locked) return stepUnlock();
    if (a.signed_in) {
      title.textContent = 'This computer is authorized';
      append(content, callout('good', 'check', `Signed in as ${a.username} on ${a.server}.`));
      return;
    }
    title.textContent = 'Authorize this computer';
    // The website's account; another one is never authorized from here.
    const lockedUser = params.username || null;
    const username = h('input', {
      class: 'form-input', autocomplete: 'username', spellcheck: 'false', value: lockedUser || '', readonly: Boolean(lockedUser),
    });
    const password = h('input', { class: 'form-input', type: 'password', autocomplete: 'current-password' });
    const totp = h('input', { class: 'form-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8 });
    const device = h('input', { class: 'form-input', value: (store.version && store.version.hostname) || '', maxlength: 80 });
    const totpField = field('Two-factor code', totp, 'From your authenticator app.');
    totpField.hidden = !w.showTotp;
    append(content,
      h('p', { class: 'dk-lead' }, 'Syncing runs in the background, so this computer needs its own access to your account and your encryption key. Confirm with your password once.'),
      callout('warn', 'lock', h('strong', null, 'This computer will be able to decrypt your files until you remove it in Devices. '),
        'The key is stored sealed on this computer and only opens with one.gy\'s help, so removing the computer in Devices makes the copy useless. Your password is not saved.'),
      h('div', { class: 'dk-form' }, field('Username', username), field('Password', password), totpField,
        field('Device name', device, 'Shown in Devices on the website.')));
    (lockedUser ? password : username).focus();
    for (const el of [username, password, totp, device]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') nextBtn.click(); });
    setReady(true, 'Authorize');
    onNext = async () => {
      if (lockedUser && !sameUser(username.value.trim(), lockedUser)) throw new Error(`This sets up sync for ${lockedUser}, the account signed in on the website.`);
      if (!username.value.trim() || !password.value) throw new Error('Enter your username and password.');
      if (!device.value.trim()) throw new Error('Give this computer a name.');
      const req = {
        server: (store.app && store.app.server_url) || DEFAULT_SERVER,
        username: username.value.trim(),
        password: password.value,
        device_name: device.value.trim(),
      };
      if (w.showTotp && totp.value.trim()) req.totp_code = totp.value.trim();
      try {
        store.account = await rpc('account.authorize', req);
      } catch (err) {
        if (err.code === 'totp_required') {
          w.showTotp = true;
          totpField.hidden = false;
          totp.focus();
          throw new Error('Enter the code from your authenticator app.');
        }
        throw new Error(AUTH_ERRORS[err.code] || err.message);
      } finally {
        password.value = '';
      }
      await loadAccount().catch(() => {});
      toast('This computer is authorized', 'success');
      return true;
    };
    return undefined;
  }

  function stepUnlock() {
    title.textContent = 'Unlock sync';
    const password = h('input', { class: 'form-input', type: 'password', autocomplete: 'current-password' });
    append(content, h('p', { class: 'dk-lead' }, 'This computer keeps your key in memory only. Enter your password to start syncing.'),
      field('Password', password));
    password.focus();
    setReady(true, 'Unlock');
    onNext = async () => {
      try {
        store.account = await rpc('account.unlock', { password: password.value });
      } finally {
        password.value = '';
      }
      return true;
    };
  }

  // ---- 2. Opt-in: a PIN instead of the password ------------------------------------
  function stepPin() {
    const a = store.account || {};
    title.textContent = 'Unlock with a PIN?';
    if (a.pin_set) {
      append(content, callout('good', 'check', pinSummary(a)));
      return;
    }
    const want = switchInput(false, (v) => { f.el.hidden = !v; setReady(true, v ? 'Save PIN' : 'Skip'); });
    const f = pinFields();
    f.el.hidden = true;
    append(content,
      h('p', { class: 'dk-lead' }, 'ONE.GY locks itself when you are away (and after a restart). Unlocking asks for your password, or for a PIN if you choose one now. You can change this later in Settings.'),
      row('Use a PIN on this computer', pinRules(null), want), f.el);
    setReady(true, 'Skip');
    onNext = async () => {
      if (f.el.hidden) return true;
      const { pin, strict } = f.value();
      try {
        store.account = await rpc('account.setPin', { pin, strict });
      } finally {
        f.clear();
      }
      toast('PIN saved', 'success');
      return true;
    };
  }

  // ---- 3. What to do ------------------------------------------------------------
  function stepAction() {
    title.textContent = 'What do you want to do?';
    const cards = h('div', { class: 'dk-cards', role: 'radiogroup', 'aria-label': 'Sync type' });
    const render = () => {
      clear(cards);
      for (const a of ACTIONS) {
        const selected = a.type === w.cfg.type;
        append(cards, h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(selected), class: `dk-card${selected ? ' is-selected' : ''}`,
          onclick: () => {
            if (!a.type) { navigate('close'); return; }
            w.cfg.type = a.type;
            render();
          },
        }, h('span', { class: 'dk-card-icon' }, icon(a.type ? SYNC_TYPES[a.type].icon : 'skip')),
        h('span', { class: 'dk-card-title' }, a.title), h('span', { class: 'dk-card-text' }, a.text)));
      }
    };
    render();
    append(content, cards);
  }

  // ---- 4. Local folder ------------------------------------------------------------
  async function validate(withRemote) {
    const req = { local_path: w.cfg.local_path, type: w.cfg.type };
    if (withRemote) req.remote_folder_id = w.cfg.type === 'full' ? null : w.cfg.remote_folder_id;
    w.validation = await rpc('syncs.validate', req);
    return w.validation;
  }

  function validationView(v, withRemote) {
    const fs = v.fs || {};
    const facts = [];
    if (fs.kind) facts.push(fs.kind);
    if (fs.case_sensitive !== undefined) facts.push(fs.case_sensitive ? 'case-sensitive' : 'not case-sensitive');
    if (Number.isFinite(fs.free_bytes)) facts.push(`${bytes(fs.free_bytes)} free`);
    if (v.local) facts.push(`${count(v.local.files)} files (${bytes(v.local.bytes)}) here`);
    if (withRemote && v.remote) facts.push(`${count(v.remote.files)} files (${bytes(v.remote.bytes)}) on one.gy`);
    return h('div', { class: 'dk-validation' },
      messageList('bad', v.errors), messageList('warn', v.warnings),
      v.ok && !(v.errors || []).length ? callout('good', 'check', 'This folder can be used.') : null,
      facts.length ? h('p', { class: 'rd-field-hint' }, facts.join(' · ')) : null);
  }

  function stepLocal() {
    title.textContent = w.cfg.type === 'mirror' ? 'Where should the copy go?' : 'Choose a folder on this computer';
    const pathBox = h('div', { class: 'dk-path-box' });
    const result = h('div', { 'aria-live': 'polite' });
    const check = async () => {
      clear(result);
      setReady(false);
      if (!w.cfg.local_path) return;
      append(result, h('p', { class: 'rd-field-hint' }, 'Checking the folder…'));
      try {
        const v = await validate(false);
        fill(result, validationView(v, false));
        setReady(Boolean(v.ok));
      } catch (err) {
        fill(result, callout('bad', 'alert', err.message));
      }
    };
    const renderPath = () => {
      fill(pathBox, icon('folder', 'dk-kind-folder'),
        h('span', { class: 'dk-path' }, w.cfg.local_path || 'No folder chosen'),
        h('button', {
          type: 'button', class: 'rd-btn rd-btn-ghost',
          onclick: async () => {
            const p = await bridge('pickFolder', { title: 'Choose a folder to sync', defaultPath: w.cfg.local_path || undefined });
            if (!p) return;
            w.cfg.local_path = p;
            if (!w.nameTouched) w.cfg.name = basename(p);
            renderPath();
            check();
          },
        }, w.cfg.local_path ? 'Change…' : 'Choose folder…'));
    };
    append(content, h('p', { class: 'dk-lead' }, 'You can create a new folder in the picker.'), pathBox, result);
    renderPath();
    if (w.cfg.local_path && !w.cfg.name) w.cfg.name = basename(w.cfg.local_path);
    check();
  }

  // ---- 5. one.gy folder ---------------------------------------------------------------
  function stepRemote() {
    title.textContent = 'Choose a folder on one.gy';
    const result = h('div', { 'aria-live': 'polite' });
    let timer = null;
    const check = () => {
      clearTimeout(timer);
      setReady(false);
      timer = setTimeout(async () => {
        fill(result, h('p', { class: 'rd-field-hint' }, 'Checking…'));
        try {
          const v = await validate(true);
          fill(result, validationView(v, true));
          setReady(Boolean(v.ok));
        } catch (err) {
          fill(result, callout('bad', 'alert', err.message));
        }
      }, 250);
    };
    if (w.cfg.type === 'full') {
      w.cfg.remote_folder_id = null;
      w.cfg.remote_path = '/';
      append(content, callout('accent', 'drive', 'Whole drive: everything on one.gy syncs with this folder.'), result);
      check();
      return;
    }
    if (w.cfg.type === 'backup' && !w.backupCustom) {
      stepBackupTarget();
      return;
    }
    const hint = w.cfg.type === 'backup'
      ? 'The folder you pick becomes a read-only backup on one.gy: only this computer can change it.'
      : 'Pick the folder to keep in step, or create a new one.';
    const useDefault = w.cfg.type === 'backup'
      ? h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: () => { w.backupCustom = false; go(index); } }, 'Use the default backup folder')
      : null;
    const picker = treePicker({
      mode: 'folder',
      e2ee: w.cfg.encryption === 'e2ee',
      onChange: (sel) => {
        w.cfg.remote_folder_id = sel.id;
        w.cfg.remote_path = sel.path;
        selected.textContent = `Selected: one.gy${sel.path === '/' ? ' (top level)' : sel.path}`;
        check();
      },
    });
    const selected = h('p', { class: 'dk-selected' });
    append(content, h('p', { class: 'dk-lead' }, hint), picker.el, selected, useDefault, result);
  }

  // Backups go to Backups/<device>/<folder> unless the user picks another
  // folder. The engine creates the folders (idempotently) on Continue.
  function stepBackupTarget() {
    title.textContent = 'Where the backup goes';
    const where = h('strong', { class: 'dk-path' }, '…');
    const result = h('div', { 'aria-live': 'polite' });
    rpc('syncs.backupTarget', { local_path: w.cfg.local_path })
      .then((t) => { where.textContent = `one.gy${t.path}`; })
      .catch((err) => fill(result, callout('bad', 'alert', err.message)));
    append(content,
      callout('accent', 'backup', h('p', null, 'This folder is backed up to ', where, '.'),
        h('p', { class: 'rd-field-hint' }, 'The copy on one.gy is read-only: only this computer changes it. Files you delete here go to the one.gy trash.')),
      h('div', { class: 'dk-btn-row' },
        h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => { w.backupCustom = true; go(index); } }, icon('folder'), 'Choose another folder…')),
      result);
    onNext = async () => {
      fill(result, h('p', { class: 'rd-field-hint' }, 'Preparing the backup folder…'));
      const t = await rpc('syncs.backupTarget', { local_path: w.cfg.local_path, create: true });
      w.cfg.remote_folder_id = t.folder_id;
      w.cfg.remote_path = t.path;
      const v = await validate(true);
      fill(result, validationView(v, true));
      if (!v.ok) throw new Error('This backup folder cannot be used. Choose another folder.');
      return true;
    };
  }

  // ---- 6. Options -------------------------------------------------------------------------
  function stepOptions() {
    title.textContent = 'Options';
    const cfg = w.cfg;
    const name = h('input', {
      class: 'form-input', value: cfg.name, maxlength: 80,
      oninput: (e) => { cfg.name = e.target.value; w.nameTouched = true; },
    });
    const folderName = basename(cfg.local_path);
    const confirmInput = h('input', {
      class: 'form-input', value: w.standardConfirm, autocomplete: 'off', spellcheck: 'false',
      oninput: (e) => { w.standardConfirm = e.target.value; },
    });
    const confirmField = field(`Type "${folderName}" to use standard encryption`, confirmInput,
      'The server will be able to read these files and their names.');
    const hideExt = row('Hide file extensions from the server', 'The website then cannot preview these files by type.',
      switchInput(cfg.hide_extensions, (v) => { cfg.hide_extensions = v; }));
    const encCards = h('div', { class: 'dk-cards dk-cards-2', role: 'radiogroup', 'aria-label': 'Encryption' });
    const renderEnc = () => {
      clear(encCards);
      for (const [value, label, text, ic] of [
        ['e2ee', 'End-to-end encrypted', 'Recommended. Only your devices can read files and names.', 'lock'],
        ['standard', 'Standard', 'The server can read these files and their names.', 'cloud'],
      ]) {
        const selected = cfg.encryption === value;
        encCards.append(h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(selected), class: `dk-card dk-card-sm${selected ? ' is-selected' : ''}`,
          onclick: () => { cfg.encryption = value; renderEnc(); },
        }, h('span', { class: 'dk-card-icon' }, icon(ic)), h('span', { class: 'dk-card-title' }, label), h('span', { class: 'dk-card-text' }, text)));
      }
      confirmField.hidden = cfg.encryption !== 'standard';
      hideExt.hidden = cfg.encryption !== 'e2ee';
    };
    renderEnc();
    const rules = h('textarea', {
      class: 'form-input is-code dk-rules', rows: 8, spellcheck: 'false', value: w.ignoreText,
      oninput: (e) => { w.ignoreText = e.target.value; },
    });
    append(content, 
      field('Name', name),
      h('div', { class: 'rd-field' }, h('span', { class: 'rd-field-label' }, 'Encryption (cannot be changed later)'), encCards),
      confirmField, hideExt,
      h('details', { class: 'dk-details' },
        h('summary', null, 'Advanced options'),
        h('div', { class: 'dk-details-body' },
          syncOptionsForm(cfg, { platform }),
          h('section', { class: 'dk-opt-group' },
            h('h3', { class: 'dk-opt-title' }, 'Filters'),
            field('Exclusion rules (.onegyignore)', rules, 'One rule per line, same format as MEGA\'s .megaignore. Example: -:*.iso skips ISO files, -d:node_modules skips those folders.')))));
    onNext = async () => {
      if (!cfg.name.trim()) cfg.name = folderName;
      if (cfg.encryption === 'standard' && w.standardConfirm.trim() !== folderName) {
        throw new Error(`Type "${folderName}" to confirm standard encryption, or choose end-to-end encrypted.`);
      }
      if (cfg.encryption === 'standard') cfg.hide_extensions = false;
      return true;
    };
  }

  // ---- 7. Preview and start -------------------------------------------------------------
  const engineConfig = () => ({ ...w.cfg, name: w.cfg.name.trim(), ignore_rules: w.ignoreText });

  function stepPreview() {
    title.textContent = 'Review and start';
    const v = w.validation || {};
    const bothHaveFiles = (v.local && v.local.files > 0) && (v.remote && v.remote.files > 0) && ['two_way', 'full'].includes(w.cfg.type);
    const summary = h('div', { 'aria-live': 'polite' });
    const strategy = h('div', { class: 'dk-radio-list', role: 'radiogroup', 'aria-label': 'Both sides have files' });
    const load = async () => {
      setReady(false, 'Start sync');
      fill(summary, h('p', { class: 'rd-field-hint' }, 'Working out what will change…'));
      try {
        w.preview = await rpc('syncs.preview', { config: engineConfig(), initial: w.initial });
        fill(summary, previewView(w.preview));
        setReady(true, 'Start sync');
      } catch (err) {
        fill(summary, callout('bad', 'alert', err.message));
      }
    };
    if (bothHaveFiles) {
      for (const [value, label, text] of INITIAL) {
        append(strategy, h('label', { class: 'dk-radio' },
          h('input', { type: 'radio', name: 'initial', value, checked: w.initial === value, onchange: () => { w.initial = value; load(); } }),
          h('span', null, h('strong', null, label), h('span', { class: 'rd-field-hint' }, text))));
      }
    }
    const t = SYNC_TYPES[w.cfg.type];
    append(content, 
      h('dl', { class: 'dk-kv' },
        h('dt', null, 'Type'), h('dd', null, t.label),
        h('dt', null, 'This computer'), h('dd', { class: 'dk-path' }, w.cfg.local_path),
        h('dt', null, 'one.gy'), h('dd', { class: 'dk-path' }, `one.gy${w.cfg.remote_path === '/' ? '' : w.cfg.remote_path}`),
        h('dt', null, 'Encryption'), h('dd', null, w.cfg.encryption === 'e2ee' ? 'End-to-end encrypted' : 'Standard')),
      bothHaveFiles ? h('div', { class: 'rd-field' }, h('span', { class: 'rd-field-label' }, 'Both sides already have files'), strategy) : null,
      summary);
    load();
    onNext = async () => {
      const sync = await rpc('syncs.create', { config: engineConfig(), initial: w.initial });
      store.syncs.set(sync.id, sync);
      await loadSyncs().catch(() => {});
      toast(`${sync.name} is syncing`, 'success');
      navigate('syncs');
      return false;
    };
  }

  function previewView(p) {
    const up = p.uploads || {};
    const down = p.downloads || {};
    const items = p.items || [];
    return h('div', { class: 'dk-preview' },
      h('div', { class: 'dk-preview-stats' },
        h('div', null, h('span', { class: 'dk-stat-num' }, count(up.count)), h('span', { class: 'dk-stat-label' }, `uploads · ${bytes(up.bytes)}`)),
        h('div', null, h('span', { class: 'dk-stat-num' }, count(down.count)), h('span', { class: 'dk-stat-label' }, `downloads · ${bytes(down.bytes)}`)),
        h('div', null, h('span', { class: 'dk-stat-num' }, count(p.conflicts)), h('span', { class: 'dk-stat-label' }, 'conflicts')),
        h('div', { class: p.deletions ? 'is-warn' : null }, h('span', { class: 'dk-stat-num' }, count(p.deletions)), h('span', { class: 'dk-stat-label' }, 'deletions'))),
      p.deletions ? callout('warn', 'alert', `${count(p.deletions)} items will be moved to trash or debris. Nothing is destroyed outright.`) : null,
      items.length ? h('details', { class: 'dk-details' },
        h('summary', null, `Show ${items.length < 200 ? 'all' : 'the first 200'} changes`),
        h('ul', { class: 'dk-preview-items' }, items.map((it) => h('li', null,
          h('span', { class: 'rd-pill' }, it.action), h('span', { class: 'dk-path' }, it.path), h('span', { class: 'dk-tree-meta' }, Number.isFinite(it.size) ? bytes(it.size) : ''))))) : null);
  }

  go(index);
  return () => {};
}
