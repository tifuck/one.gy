// Settings tab of the sync panel (plan 10.6). App-owned settings (window,
// autostart, server, updates, notifications) go through appSettings;
// everything else is the engine's settings.get / settings.set. Changes save
// as soon as they are made. The theme follows the website's own switch.
import {
  h, icon, clear, append, fill, field, row, select, switchInput, pageHead,
} from '../components/dom.js';
import { confirmDialog } from '../components/dialog.js';
import { pickRemote } from '../components/tree-picker.js';
import { toast, toastError } from '../components/toast.js';
import { bytes, percent, SYNC_TYPES } from '../components/format.js';
import {
  rpc, bridge, appSettings, store, on, navigate, loadAccount,
} from '../store.js';

const TABS = [
  ['general', 'General'], ['account', 'Account'], ['syncs', 'Syncs'], ['folders', 'Folders'], ['network', 'Network'],
  ['security', 'Security'], ['advanced', 'Advanced'],
];
const NOTIFY = [
  ['conflict', 'Conflicts'], ['issue', 'Sync issues'], ['mass_delete', 'Large deletions'],
  ['transfer', 'Finished transfers'], ['revoked', 'Device removed'], ['info', 'Updates and other news'],
];
const INHERITLESS = [['pause', 'Pause'], ['continue', 'Keep syncing']];

async function saveApp(patch) {
  try {
    store.app = await appSettings.set(patch);
    toast('Saved', 'success', 1600);
  } catch (err) {
    toastError(err);
  }
}

async function saveEngine(patch) {
  try {
    store.settings = await rpc('settings.set', { patch });
    toast('Saved', 'success', 1600);
  } catch (err) {
    toastError(err);
  }
}

function num(value, min, max, onchange) {
  return h('input', {
    type: 'number', class: 'form-input dk-num', min, max, value,
    onchange: (e) => {
      const n = Math.min(max, Math.max(min, Math.round(Number(e.target.value)) || min));
      e.target.value = n;
      onchange(n);
    },
  });
}

function panel(title, sub, ...rows) {
  return h('section', { class: 'rd-panel' },
    h('header', { class: 'rd-panel-head' }, h('div', null, h('h2', { class: 'rd-panel-title' }, title), sub ? h('p', { class: 'rd-panel-sub' }, sub) : null)),
    h('div', { class: 'rd-panel-body' }, ...rows));
}

function general() {
  const a = store.app;
  return [
    panel('Window', null,
      row('Open at login', 'Start ONE.GY Desktop in the tray when you sign in to this computer.', switchInput(a.launch_at_login, (v) => saveApp({ launch_at_login: v }))),
      row('Start minimized', 'Open in the tray instead of showing the window.', switchInput(a.start_minimized, (v) => saveApp({ start_minimized: v }))),
      row('Keep running when the window is closed', 'Syncing continues in the tray. Quit from the tray menu.', switchInput(a.close_to_tray, (v) => saveApp({ close_to_tray: v }))),
      row('Prevent sleep while syncing', null, switchInput(a.prevent_sleep, (v) => saveApp({ prevent_sleep: v })))),
    panel('Updates', store.version ? `Version ${store.version.app}` : null,
      row('Install updates automatically', 'Downloads and installs in the background, then restarts the app while you are away from it. The .deb and .rpm installs are updated by the system every 30 minutes either way; this only restarts the app.', switchInput(a.auto_update, (v) => saveApp({ auto_update: v }))),
      row('Update channel', 'Beta gets new versions first.', select([['stable', 'Stable'], ['beta', 'Beta']], a.update_channel, (v) => saveApp({ update_channel: v })))),
    panel('Notifications', null,
      ...NOTIFY.map(([k, label]) => row(label, null, switchInput(a.notify[k], (v) => saveApp({ notify: { [k]: v } }))))),
    server(),
  ];
}

function server() {
  const current = store.app.server_url;
  const input = h('input', { class: 'form-input', type: 'url', value: current, spellcheck: 'false' });
  const result = h('p', { class: 'rd-field-hint', 'aria-live': 'polite' });
  const check = h('button', {
    type: 'button', class: 'rd-btn rd-btn-ghost',
    onclick: async () => {
      result.textContent = 'Checking…';
      const res = await bridge('probeServer', input.value).catch((e) => ({ ok: false, message: e.message }));
      result.textContent = res.message;
      if (!res.ok || res.origin === current) return;
      store.app = await appSettings.set({ server_url: res.origin });
      input.value = res.origin;
      result.textContent = `${res.message} The website now loads from ${res.origin}.`;
    },
  }, 'Check and use');
  return panel('Server', `The website in this app is ${current}.`,
    h('details', { class: 'dk-details' },
      h('summary', null, 'Change server'),
      h('div', { class: 'dk-details-body' },
        h('p', { class: 'rd-field-hint' }, 'For self-hosted one.gy servers. The address must use https. Sync stays with the server this computer was set up for until you sign out of sync.'),
        h('div', { class: 'dk-inline' }, field('Server address', input), check),
        result)));
}

function account() {
  const a = store.account;
  if (!a) return [panel('Account', null, h('p', null, 'The sync engine is not running.'))];
  if (!a.signed_in) {
    return [panel('Account', null,
      h('p', null, 'This computer is not set up for sync yet.'),
      h('button', { type: 'button', class: 'rd-btn rd-btn-primary', onclick: () => navigate('wizard') }, 'Set up this computer'))];
  }
  const used = percent(a.storage_used, a.storage_limit);
  const fill = h('div', { class: 'rd-meter-fill' });
  fill.style.width = `${used}%`;
  return [
    panel('Account', null,
      h('dl', { class: 'dk-kv' },
        h('dt', null, 'User'), h('dd', null, a.username),
        h('dt', null, 'Server'), h('dd', null, a.server),
        h('dt', null, 'This device'), h('dd', null, a.device_name || '–'),
        h('dt', null, 'Storage'), h('dd', null, a.storage_limit > 0 ? `${bytes(a.storage_used)} of ${bytes(a.storage_limit)}` : bytes(a.storage_used))),
      a.storage_limit > 0 ? h('div', { class: 'rd-meter', role: 'progressbar', 'aria-valuenow': Math.round(used), 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill) : null,
      h('div', { class: 'dk-btn-row' },
        h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => bridge('openSite', '/account').catch(toastError) }, icon('external'), 'Open account page'))),
    panel('Sign out of sync on this computer', 'Syncing stops and the keys are removed from this computer. Your files stay where they are. The website stays signed in.',
      h('button', {
        type: 'button', class: 'rd-btn rd-btn-danger',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Sign out of sync on this computer?',
            message: 'All syncs pause, this computer is removed from your devices, and its keys are deleted. Local files are kept.',
            confirmLabel: 'Sign out', danger: true,
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
      }, 'Sign out of sync')),
  ];
}

function syncs() {
  const s = store.settings;
  const d = s.defaults || {};
  const setDefault = (k) => (v) => saveEngine({ defaults: { ...d, [k]: v } }).then(() => { Object.assign(d, { [k]: v }); });
  const list = [...store.syncs.values()];
  return [
    panel('Syncs on this computer', null,
      list.length
        ? h('ul', { class: 'dk-mini-list' }, list.map((x) => h('li', null, h('span', null, x.name), h('span', { class: 'dk-path' }, x.local_path))))
        : h('p', { class: 'rd-field-hint' }, 'None yet.'),
      h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => navigate('syncs') }, 'Manage syncs')),
    panel('Defaults for new syncs', null,
      row('Type', null, select(Object.entries(SYNC_TYPES).filter(([k]) => k !== 'full').map(([k, v]) => [k, v.label]), d.type, setDefault('type'))),
      row('When a file changed on both sides', null, select([['keep_both', 'Keep both copies'], ['prefer_remote', 'Prefer one.gy'], ['prefer_local', 'Prefer this computer'], ['ask', 'Ask me']], d.conflict_policy, setDefault('conflict_policy'))),
      row('Issue handling', null, select([['smart', 'Smart'], ['advanced', 'Advanced']], d.issue_mode, setDefault('issue_mode'))),
      row('Keep local deleted files for (days)', '0 uses the system trash.', num(d.debris_days ?? 30, 0, 3650, setDefault('debris_days'))),
      row('Thumbnails for images', null, switchInput(d.thumbnails !== false, setDefault('thumbnails')))),
  ];
}

function folders(rerender) {
  const a = store.app;
  const up = a.default_upload_folder;
  const pick = async () => {
    const target = await pickRemote({ title: 'Default upload folder', confirmLabel: 'Use this folder' });
    if (target) await saveApp({ default_upload_folder: { id: target.id, path: target.path } });
    rerender();
  };
  const pickDir = async () => {
    try {
      const dir = await bridge('pickFolder', { title: 'Default download folder', defaultPath: a.default_download_dir || undefined });
      if (dir) await saveApp({ default_download_dir: dir });
      rerender();
    } catch (err) {
      toastError(err);
    }
  };
  const clearBtn = (patch) => h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: () => saveApp(patch).then(rerender) }, 'Ask every time');
  const clearDebris = async (s) => {
    const ok = await confirmDialog({
      title: `Clear debris of ${s.name}?`,
      message: 'Debris holds the files sync deleted or replaced on this computer. They are deleted now and cannot be restored from there.',
      confirmLabel: 'Clear debris', danger: true,
    });
    if (!ok) return;
    try {
      await rpc('syncs.clearDebris', { id: s.id });
      toast('Debris cleared', 'success');
    } catch (err) {
      toastError(err);
    }
  };
  const list = [...store.syncs.values()].sort((x, y) => String(x.name).localeCompare(String(y.name)));
  return [
    panel('Default folders', null,
      row('Upload folder on one.gy', `Used by Upload… in the tray. Now: ${up ? `one.gy${up.path === '/' ? '' : up.path}` : 'ask every time'}.`,
        h('div', { class: 'dk-btn-row' }, h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: pick }, 'Choose…'),
          up ? clearBtn({ default_upload_folder: null }) : null)),
      row('Download folder on this computer', `Used by downloads you start yourself. Now: ${a.default_download_dir || 'ask every time'}.`,
        h('div', { class: 'dk-btn-row' }, h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: pickDir }, 'Choose…'),
          a.default_download_dir ? clearBtn({ default_download_dir: '' }) : null))),
    panel('Debris', 'Deleted and replaced files wait in each sync\'s .onegy/debris folder for the days set in its options.',
      list.length
        ? h('ul', { class: 'dk-mini-list' }, list.map((s) => h('li', null,
          h('span', null, s.name, ' ', h('span', { class: 'dk-path' }, s.local_path)),
          h('button', { type: 'button', class: 'rd-btn rd-btn-ghost rd-btn-sm', onclick: () => clearDebris(s) }, 'Clear debris now'))))
        : h('p', { class: 'rd-field-hint' }, 'No syncs yet.')),
    panel('Caches', 'Forgets the cached list of one.gy folders and the decrypted keys, then loads them again. Your files are not touched.',
      h('div', { class: 'dk-btn-row' }, h('button', {
        type: 'button', class: 'rd-btn rd-btn-ghost',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await rpc('engine.clearCaches');
            toast('Caches cleared', 'success');
          } catch (err) {
            toastError(err);
          } finally {
            e.currentTarget.disabled = false;
          }
        },
      }, 'Clear caches'))),
  ];
}

function network() {
  const s = store.settings;
  const proxy = { mode: 'system', url: '', ...s.proxy };
  const proxyUrl = h('input', {
    class: 'form-input', value: proxy.url, placeholder: 'socks5://host:1080 or http://host:8080', spellcheck: 'false',
    onchange: (e) => saveEngine({ proxy: { mode: 'manual', url: e.target.value.trim() } }),
  });
  const proxyField = field('Proxy address', proxyUrl, 'Credentials, if any, go in the address.');
  proxyField.hidden = proxy.mode !== 'manual';
  return [
    panel('Speed', '0 means no limit.',
      row('Upload limit (KB/s)', null, num(s.upload_kbps, 0, 10000000, (v) => saveEngine({ upload_kbps: v }))),
      row('Download limit (KB/s)', null, num(s.download_kbps, 0, 10000000, (v) => saveEngine({ download_kbps: v }))),
      row('Parallel uploads', null, num(s.parallel_up, 1, 6, (v) => saveEngine({ parallel_up: v }))),
      row('Parallel downloads', null, num(s.parallel_down, 1, 6, (v) => saveEngine({ parallel_down: v })))),
    panel('Proxy', null,
      row('Proxy', null, select([['none', 'None'], ['system', 'Use system settings'], ['manual', 'Manual']], proxy.mode, (v) => {
        proxyField.hidden = v !== 'manual';
        if (v !== 'manual') saveEngine({ proxy: { mode: v, url: '' } });
      })),
      proxyField),
    panel('Metered networks and battery', null,
      row('On a metered network', null, select(INHERITLESS, s.metered, (v) => saveEngine({ metered: v }))),
      row('On battery', null, select(INHERITLESS, s.battery, (v) => saveEngine({ battery: v }))),
      row('Check one.gy for changes at most every (seconds)', null, num(s.poll_floor_seconds, 5, 3600, (v) => saveEngine({ poll_floor_seconds: v })))),
  ];
}

function security() {
  const s = store.settings;
  const openSite = (p) => () => bridge('openSite', p).catch(toastError);
  return [
    panel('This computer', null,
      row('Ask for my password when the app starts', 'The key is then kept in memory only, never in the system key store.', switchInput(s.require_password_on_start, (v) => saveEngine({ require_password_on_start: v }))),
      row('Unlock the website with this device\'s key', 'Encrypted names show up on the Files page without typing your password. Any script running on the one.gy site in this app could also get the key, just as it could while you are unlocked in a browser.',
        switchInput(s.web_unlock, (v) => saveEngine({ web_unlock: v })))),
    panel('Account security', 'These open on the website.',
      h('div', { class: 'dk-btn-row' },
        h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: openSite('/account') }, 'Change password'),
        h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: openSite('/account') }, 'Export recovery key'),
        h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: openSite('/account/devices') }, 'Other devices'))),
  ];
}

function advanced() {
  const s = store.settings;
  const info = h('dl', { class: 'dk-kv' });
  rpc('engine.info').then((e) => {
    append(info, h('dt', null, 'Engine'), h('dd', null, `${e.version} (protocol ${e.protocol})`),
      h('dt', null, 'Data folder'), h('dd', { class: 'dk-path' }, e.state_dir));
  }).catch(() => {});
  if (store.version) append(info, h('dt', null, 'App'), h('dd', null, `${store.version.app} · Electron ${store.version.electron}`));
  return [
    panel('Sync engine', null,
      row('Full rescan every (minutes)', 'Catches changes the file watcher missed.', num(s.rescan_minutes, 5, 1440, (v) => saveEngine({ rescan_minutes: v }))),
      row('Pause and ask when a sync would delete more than (items)', null, num(s.mass_delete_count, 1, 1000000, (v) => saveEngine({ mass_delete_count: v }))),
      row('…or more than (% of the sync)', null, num(s.mass_delete_percent, 1, 100, (v) => saveEngine({ mass_delete_percent: v }))),
      row('Log detail', 'Logs never contain file names unless set to debug.', select([['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Normal'], ['debug', 'Debug']], s.log_level, (v) => saveEngine({ log_level: v })))),
    panel('Diagnostics', 'A zip with logs and a redacted summary. Check it before you send it to anyone.',
      info,
      h('div', { class: 'dk-btn-row' },
        h('button', {
          type: 'button', class: 'rd-btn rd-btn-ghost',
          onclick: async () => {
            try {
              const res = await bridge('exportDiagnostics');
              if (res) toast('Diagnostics saved', 'success');
            } catch (err) {
              toastError(err);
            }
          },
        }, 'Export diagnostics'),
        h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => bridge('openDataFolder').catch(toastError) }, 'Open data folder'))),
  ];
}

const RENDER = {
  general, account, syncs, folders, network, security, advanced,
};
const NEEDS_ENGINE = new Set(['syncs', 'network', 'security', 'advanced']);

export function mount(container, params = {}) {
  let tab = RENDER[params.tab] ? params.tab : 'general';
  const tabs = h('div', { class: 'rd-tabs', role: 'tablist', 'aria-label': 'Settings sections' });
  const body = h('div', { class: 'dk-settings-body', role: 'tabpanel' });

  async function render() {
    clear(tabs);
    for (const [id, label] of TABS) {
      append(tabs, h('button', {
        type: 'button', role: 'tab', class: 'rd-tab', 'aria-selected': String(tab === id),
        onclick: () => { tab = id; render(); },
      }, label));
    }
    clear(body);
    if (NEEDS_ENGINE.has(tab)) {
      try {
        store.settings = await rpc('settings.get');
      } catch (err) {
        append(body, h('div', { class: 'rd-callout is-warn' }, icon('alert'), h('div', null, `These settings need the sync engine: ${err.message}`)));
        return;
      }
    }
    if (tab === 'account') await loadAccount().catch(() => {});
    if (!store.app) store.app = await appSettings.get();
    fill(body, ...RENDER[tab](render));
  }

  append(container, h('div', { class: 'adm-narrow' },
    pageHead('Settings', 'How ONE.GY Desktop and its syncs behave on this computer.'), tabs, body));
  render();
  return on('engine', (state) => { if (state === 'connected' && NEEDS_ENGINE.has(tab)) render(); });
}
