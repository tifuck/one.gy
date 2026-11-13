// Per-sync options form (plan 6.2), shared by the wizard and the sync settings
// dialog. Edits the given config object in place and calls onChange().
import { h, field, row, select, switchInput } from './dom.js';

const POLICY = [
  ['keep_both', 'Keep both copies'],
  ['prefer_remote', 'Prefer one.gy'],
  ['prefer_local', 'Prefer this computer'],
  ['ask', 'Ask me'],
];
const ISSUE_MODE = [['smart', 'Smart: fix what is safe automatically'], ['advanced', 'Advanced: ask about everything']];
const INHERIT = [['inherit', 'Use the app setting'], ['pause', 'Pause'], ['continue', 'Keep syncing']];
const SCHEDULE = [['live', 'Live'], ['interval', 'Every few minutes'], ['window', 'Only during set hours'], ['manual', 'Only when I click Sync now']];

function numberInput(value, { min = 0, max, step = 1 }, onchange) {
  return h('input', {
    type: 'number', class: 'form-input dk-num', min, max, step, value,
    onchange: (e) => {
      const n = Math.round(Number(e.target.value));
      const clamped = Math.min(max ?? Infinity, Math.max(min, Number.isFinite(n) ? n : min));
      e.target.value = clamped;
      onchange(clamped);
    },
  });
}

// deletes: false leaves out "Sync deletions" (the wizard asks backups directly).
export function syncOptionsForm(cfg, { platform = 'linux', deletes = true, onChange = () => {} } = {}) {
  const set = (fn) => (v) => { fn(v); onChange(); };
  cfg.schedule = { mode: 'live', interval_minutes: 15, window: null, ...cfg.schedule };
  cfg.limits = { upload_kbps: 0, download_kbps: 0, ...cfg.limits };

  const intervalField = field('Minutes between runs', numberInput(cfg.schedule.interval_minutes, { min: 1, max: 1440 }, set((v) => { cfg.schedule.interval_minutes = v; })));
  const win = cfg.schedule.window || { from: '22:00', to: '06:00' };
  const timeInput = (key) => h('input', {
    type: 'time', class: 'form-input', value: win[key],
    onchange: set((e) => { win[key] = e.target.value; cfg.schedule.window = { ...win }; }),
  });
  const windowField = h('div', { class: 'dk-grid-2' }, field('From', timeInput('from')), field('To', timeInput('to')));
  const showSchedule = () => {
    intervalField.hidden = cfg.schedule.mode !== 'interval';
    windowField.hidden = cfg.schedule.mode !== 'window';
  };
  const debris = field('Keep deleted files for (days)', numberInput(cfg.debris_days, { min: 0, max: 3650 }, set((v) => { cfg.debris_days = v; })),
    'Deleted and replaced files wait in .onegy/debris first. Set to 0 to send them straight to the system trash.');

  const el = h('div', { class: 'dk-options' },
    h('section', { class: 'dk-opt-group' },
      h('h3', { class: 'dk-opt-title' }, 'Conflicts and issues'),
      field('When a file changes on both sides', select(POLICY, cfg.conflict_policy, set((v) => { cfg.conflict_policy = v; })),
        '“Prefer” options keep the other copy as an older version, so nothing is lost.'),
      field('Issue handling', select(ISSUE_MODE, cfg.issue_mode, set((v) => { cfg.issue_mode = v; })))),
    h('section', { class: 'dk-opt-group' },
      h('h3', { class: 'dk-opt-title' }, 'Deletions'),
      deletes ? row('Sync deletions', 'When off, deleting a file on one side leaves the other copy alone.',
        switchInput(cfg.propagate_deletes, set((v) => { cfg.propagate_deletes = v; }))) : null,
      debris),
    h('section', { class: 'dk-opt-group' },
      h('h3', { class: 'dk-opt-title' }, 'Schedule'),
      field('When to sync', select(SCHEDULE, cfg.schedule.mode, set((v) => { cfg.schedule.mode = v; if (v === 'window') cfg.schedule.window = { ...win }; showSchedule(); }))),
      intervalField, windowField),
    h('section', { class: 'dk-opt-group' },
      h('h3', { class: 'dk-opt-title' }, 'Bandwidth and power'),
      h('div', { class: 'dk-grid-2' },
        field('Upload limit (KB/s)', numberInput(cfg.limits.upload_kbps, { min: 0, max: 10000000 }, set((v) => { cfg.limits.upload_kbps = v; })), '0 uses the app setting.'),
        field('Download limit (KB/s)', numberInput(cfg.limits.download_kbps, { min: 0, max: 10000000 }, set((v) => { cfg.limits.download_kbps = v; })), '0 uses the app setting.')),
      h('div', { class: 'dk-grid-2' },
        field('On metered networks', select(INHERIT, cfg.metered, set((v) => { cfg.metered = v; }))),
        field('On battery power', select(INHERIT, cfg.battery, set((v) => { cfg.battery = v; }))))),
    h('section', { class: 'dk-opt-group' },
      h('h3', { class: 'dk-opt-title' }, 'Files'),
      row('Image thumbnails', 'Encrypted previews, so photos look the same on the website.',
        switchInput(cfg.thumbnails, set((v) => { cfg.thumbnails = v; }))),
      platform === 'linux'
        ? row('Keep the executable bit', 'Restores file permissions on other Linux computers.',
          switchInput(cfg.keep_exec_bit, set((v) => { cfg.keep_exec_bit = v; })))
        : null,
      platform === 'win32'
        ? row('Include hidden and system files', 'Off by default, so Windows clutter like desktop.ini stays local.',
          switchInput(cfg.include_hidden_system, set((v) => { cfg.include_hidden_system = v; })))
        : null));
  showSchedule();
  return el;
}

// Defaults for a new sync, from the engine's settings.defaults when known.
export function newSyncConfig(defaults = {}, platform = 'linux') {
  return {
    name: '',
    type: defaults.type || 'two_way',
    local_path: '',
    remote_folder_id: null,
    remote_path: '/',
    encryption: 'e2ee',
    hide_extensions: false,
    conflict_policy: defaults.conflict_policy || 'keep_both',
    issue_mode: defaults.issue_mode || 'smart',
    propagate_deletes: true,
    debris_days: Number.isFinite(defaults.debris_days) ? defaults.debris_days : 30,
    schedule: { mode: 'live', interval_minutes: 15, window: null },
    limits: { upload_kbps: 0, download_kbps: 0 },
    metered: 'inherit',
    battery: 'inherit',
    keep_exec_bit: platform === 'linux',
    include_hidden_system: false,
    thumbnails: defaults.thumbnails !== false,
  };
}
