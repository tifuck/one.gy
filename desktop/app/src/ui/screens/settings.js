// Settings in the panel (plan 10.6), split by what they are about. Sync
// settings (the sync panel's Settings; tabs New syncs, Network, Folders,
// Notifications, Advanced): anything that changes how files sync or what you
// hear about it. App settings (the rail's gear; General, Account, Security,
// Updates, About, one sidebar entry each): the app itself, whether or not
// anything syncs. App-owned values (window, autostart, server, updates,
// notifications, prevent sleep) go through appSettings; everything else is
// the engine's settings.get / settings.set. Changes save as soon as they are
// made. The theme follows the website's own switch.
import {
  h, icon, clear, append, fill, field, row, select, switchInput, pageHead, nextId,
} from '../components/dom.js';
import { confirmDialog } from '../components/dialog.js';
import { pinDialog, pinRules, pinSummary } from '../components/pin.js';
import { pickRemote } from '../components/tree-picker.js';
import { toast, toastError } from '../components/toast.js';
import {
  bytes, percent, ago, SYNC_TYPES,
} from '../components/format.js';
import {
  rpc, bridge, appSettings, store, on, navigate, loadAccount,
} from '../store.js';

const SYNC_TABS = [['defaults', 'New syncs'], ['network', 'Network'], ['folders', 'Folders'], ['notifications', 'Notifications'], ['advanced', 'Advanced']];
const APP_PAGES = {
  general: ['General', 'How ONE.GY starts and runs on this computer.'],
  account: ['Account', 'The account this computer is signed in to.'],
  security: ['Security', 'The app lock and how this computer keeps your key.'],
  updates: ['Updates', 'Which version runs here and how it updates.'],
  about: ['About', 'Versions and diagnostics for support.'],
};
const SYNC_NOTIFY = [['conflict', 'Conflicts'], ['issue', 'Sync issues'], ['mass_delete', 'Large deletions'], ['transfer', 'Finished transfers']];
const APP_NOTIFY = [['revoked', 'This computer removed from your devices'], ['info', 'Updates and other news']];
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

// What the updater is doing and the one thing to do next: [hint, button label, action, primary].
function updateStep(u) {
  const v = u.version;
  switch (u.state) {
    case 'checking': return ['Checking for updates…', 'Checking…', null];
    case 'downloading': return [`Downloading ${v}${u.progress ? ` · ${u.progress}%` : ''}…`, 'Downloading…', null];
    case 'available': return [`ONE.GY ${v} is available.`, 'Update and restart', 'installUpdate', true];
    case 'installing': return [`Installing ${v || 'the update'}… ONE.GY restarts when it is done.`, 'Installing…', null];
    case 'ready': return [`${v ? `ONE.GY ${v}` : 'A new version'} is ready. Restart to use it; you'll be back where you left off.`, 'Restart now', 'installUpdate', true];
    case 'error': return [u.error, u.failed === 'install' ? 'Try again' : 'Check for updates', u.failed === 'install' ? 'installUpdate' : 'checkForUpdates'];
    case 'current': return [`Up to date · checked ${ago(u.checked_at)}.`, 'Check for updates', 'checkForUpdates'];
    default: return ['', 'Check for updates', 'checkForUpdates'];
  }
}

function updateRow() {
  const u0 = store.update || { supported: false };
  const hint = h('p', { class: 'rd-field-hint', 'aria-live': 'polite' });
  const button = h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', id: nextId('r') });
  let action = null;
  const paint = (u) => {
    const [text, label, next, primary] = u.supported ? updateStep(u) : ['This build does not update itself.', 'Check for updates', null];
    hint.textContent = text;
    button.textContent = label;
    button.className = `rd-btn ${primary ? 'rd-btn-primary' : 'rd-btn-ghost'}`;
    button.disabled = !next;
    action = next;
  };
  button.addEventListener('click', async () => {
    if (!action) return;
    button.disabled = true;
    try {
      store.update = await bridge(action);
    } catch (err) {
      toastError(err);
    }
    paint(store.update || u0);
  });
  const off = on('app:update', (u) => (hint.isConnected ? paint(u) : off()));
  paint(u0);
  return h('div', { class: 'rd-field-row' },
    h('div', { class: 'rd-field-text' },
      h('label', { class: 'rd-field-label', for: button.id }, store.version ? `ONE.GY ${store.version.app}` : 'ONE.GY'),
      hint),
    button);
}

function general() {
  const a = store.app;
  return [
    panel('Window', null,
      row('Open at login', 'Start ONE.GY in the tray when you sign in to this computer.', switchInput(a.launch_at_login, (v) => saveApp({ launch_at_login: v }))),
      row('Start minimized', 'Open in the tray instead of showing the window.', switchInput(a.start_minimized, (v) => saveApp({ start_minimized: v }))),
      row('Keep running when the window is closed', 'Syncing continues in the tray. Quit from the tray menu.', switchInput(a.close_to_tray, (v) => saveApp({ close_to_tray: v }))),
      store.version && store.version.platform === 'linux'
        ? row('Open the status popover under the tray icon', 'GNOME on Wayland lets no app place its windows, so ONE.GY runs through XWayland there. Turn this off if text looks blurry with fractional scaling. Applies the next time ONE.GY starts.',
          switchInput(a.linux_x11, (v) => saveApp({ linux_x11: v })))
        : null),
    notifyPanel(APP_NOTIFY, 'Notifications about syncing are in Sync > Settings > Notifications.'),
    server(),
  ];
}

function updates() {
  const a = store.app;
  // deb / rpm installs follow the stable releases (build/linux/update-system.sh).
  const system = store.update && ['deb', 'rpm'].includes(store.update.kind);
  return [
    panel('Updates', null,
      updateRow(),
      row('Check for updates automatically', system
        ? 'Checks every 30 minutes and asks before it restarts; while ONE.GY is in the tray it restarts by itself. This computer also installs new versions in the background every 30 minutes either way.'
        : 'Checks every 30 minutes, downloads in the background and asks before it restarts; while ONE.GY is in the tray it restarts by itself.',
      switchInput(a.auto_update, (v) => saveApp({ auto_update: v }))),
      system ? null : row('Update channel', 'Beta gets new versions first.', select([['stable', 'Stable'], ['beta', 'Beta']], a.update_channel, (v) => saveApp({ update_channel: v })))),
  ];
}

function notifyPanel(kinds, sub) {
  const a = store.app;
  return panel('Notifications', sub, ...kinds.map(([k, label]) => row(label, null, switchInput(a.notify[k], (v) => saveApp({ notify: { [k]: v } })))));
}

const notifications = () => [notifyPanel(SYNC_NOTIFY, 'Updates and device notifications are in App settings > General.')];

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
        h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => navigate('close', { path: '/account' }) }, icon('external'), 'Open account page'))),
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

function defaults() {
  const s = store.settings;
  const d = s.defaults || {};
  const setDefault = (k) => (v) => saveEngine({ defaults: { ...d, [k]: v } }).then(() => { Object.assign(d, { [k]: v }); });
  return [
    panel('Defaults for new syncs', 'Each sync can change these later in its own settings.',
      row('Type', 'Selected first in Add sync.', select(['two_way', 'backup', 'mirror'].map((k) => [k, SYNC_TYPES[k].label]), d.type, setDefault('type'))),
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
    panel('Power and metered networks', 'Each sync can override the first two in its own settings.',
      row('On a metered network', null, select(INHERITLESS, s.metered, (v) => saveEngine({ metered: v }))),
      row('On battery', null, select(INHERITLESS, s.battery, (v) => saveEngine({ battery: v }))),
      row('Prevent sleep while syncing', null, switchInput(store.app.prevent_sleep, (v) => saveApp({ prevent_sleep: v }))),
      row('Check one.gy for changes at most every (seconds)', null, num(s.poll_floor_seconds, 5, 3600, (v) => saveEngine({ poll_floor_seconds: v })))),
  ];
}

function security(rerender) {
  const s = store.settings;
  const a = store.account || {};
  const openSite = (p) => () => navigate('close', { path: p });
  const pinActions = a.pin_set
    ? [
      h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: async () => { if (await pinDialog({ title: 'Change PIN', strict: a.pin_strict })) rerender(); } }, 'Change PIN'),
      h('button', {
        type: 'button', class: 'rd-btn rd-btn-ghost',
        onclick: async () => {
          if (!await confirmDialog({ title: 'Stop using a PIN?', message: 'ONE.GY then asks for your password whenever it is locked.', confirmLabel: 'Stop using a PIN' })) return;
          try {
            store.account = await rpc('account.removePin');
            toast('PIN removed', 'success');
            rerender();
          } catch (err) {
            toastError(err);
          }
        },
      }, 'Stop using a PIN')]
    : [h('button', { type: 'button', class: 'rd-btn rd-btn-primary', onclick: async () => { if (await pinDialog()) rerender(); } }, 'Set up a PIN')];
  return [
    panel('App lock', 'ONE.GY locks when it starts, when this computer sleeps or locks its screen, and after the idle time below. Syncing keeps going while it is locked.',
      row('Unlock with a PIN', `${pinSummary(a)} ${a.pin_set ? '' : pinRules(null)}`, h('div', { class: 'dk-btn-row' }, pinActions)),
      row('Lock after I am away for', null, select([[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'Only on start, sleep and screen lock']],
        store.app.lock_after_minutes, (v) => saveApp({ lock_after_minutes: Number(v) }))),
      a.lock_enabled ? h('div', { class: 'dk-btn-row' }, h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', onclick: () => bridge('lockNow').catch(toastError) }, icon('lock'), 'Lock now')) : null,
      row('Request signing key', a.hardware_key ? 'Kept in this computer\'s security chip (TPM): a copy of the app data cannot be used on another computer.' : 'A software key in the system key store (this computer has no usable security chip).',
        h('span', { class: 'rd-pill' }, a.signed_requests ? (a.hardware_key ? 'Hardware' : 'Software') : 'Not yet'))),
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
  return [
    panel('Safety', null,
      row('Pause and ask when a sync would delete more than (items)', null, num(s.mass_delete_count, 1, 1000000, (v) => saveEngine({ mass_delete_count: v }))),
      row('…or more than (% of the sync)', null, num(s.mass_delete_percent, 1, 100, (v) => saveEngine({ mass_delete_percent: v })))),
    panel('Sync engine', null,
      row('Full rescan every (minutes)', 'Catches changes the file watcher missed.', num(s.rescan_minutes, 5, 1440, (v) => saveEngine({ rescan_minutes: v }))),
      row('Log detail', 'For troubleshooting with Export diagnostics in App settings > About. Logs never contain file names unless set to debug.',
        select([['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Normal'], ['debug', 'Debug']], s.log_level, (v) => saveEngine({ log_level: v })))),
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

// Works without the engine too: its rows then stay out.
function about() {
  const info = h('dl', { class: 'dk-kv' });
  if (store.version) append(info, h('dt', null, 'App'), h('dd', null, `${store.version.app} · Electron ${store.version.electron}`));
  rpc('engine.info').then((e) => {
    append(info, h('dt', null, 'Engine'), h('dd', null, `${e.version} (protocol ${e.protocol})`),
      h('dt', null, 'Data folder'), h('dd', { class: 'dk-path' }, e.state_dir));
  }).catch(() => {});
  return [
    panel('Version', null, info),
    panel('Diagnostics', 'A zip with logs and a redacted summary. Check it before you send it to anyone.',
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
  defaults, network, folders, advanced, general, account, security, notifications, updates, about,
};
const NEEDS_ENGINE = new Set(['defaults', 'network', 'advanced', 'security']);

// tabList: [[id, label]] for a tab bar, or null for a single section.
function settingsPage(container, title, sub, tabList, first) {
  let tab = first;
  const tabs = tabList ? h('div', { class: 'rd-tabs', role: 'tablist', 'aria-label': 'Settings sections' }) : null;
  const body = h('div', { class: 'dk-settings-body', role: tabs ? 'tabpanel' : null });

  async function render() {
    if (tabs) {
      clear(tabs);
      for (const [id, label] of tabList) {
        append(tabs, h('button', {
          type: 'button', role: 'tab', class: 'rd-tab', 'aria-selected': String(tab === id),
          onclick: () => { tab = id; render(); },
        }, label));
      }
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
    if (tab === 'account' || tab === 'security') await loadAccount().catch(() => {});
    if (tab === 'updates') store.update = await bridge('updateState').catch(() => store.update);
    if (!store.app) store.app = await appSettings.get();
    // The account's own settings need this computer signed in; account() says so.
    const signedIn = store.account && store.account.signed_in;
    fill(body, ...(tab === 'security' && !signedIn ? account() : RENDER[tab](render)));
  }

  append(container, h('div', { class: 'adm-narrow' }, pageHead(title, sub), tabs, body));
  render();
  return on('engine', (state) => { if (state === 'connected' && (NEEDS_ENGINE.has(tab) || tab === 'about' || tab === 'account')) render(); });
}

// The sync panel's Settings.
export function mount(container, params = {}) {
  const first = SYNC_TABS.some(([id]) => id === params.tab) ? params.tab : SYNC_TABS[0][0];
  return settingsPage(container, 'Sync settings', 'How syncing behaves on this computer.', SYNC_TABS, first);
}

// One App settings section (app.js APP_SECTIONS).
export function mountApp(container, { section }) {
  const [title, sub] = APP_PAGES[section];
  return settingsPage(container, title, sub, null, section);
}
