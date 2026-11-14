// Settings in the panel (plan 10.6), split by what they are about. Sync
// settings (the sync panel's Settings; tabs New syncs, Network, Folders,
// Notifications, Advanced): anything that changes how files sync or what you
// hear about it. App settings (the rail's gear; General, Account, Security,
// Updates, About, one sidebar entry each): the app itself, whether or not
// anything syncs. App-owned values (window, autostart, server, updates,
// notifications, prevent sleep) go through appSettings; everything else is
// the engine's settings.get / settings.set. Changes save as soon as they are
// made. The theme follows the website's own switch.
// Every panel is a list of rows: label and hint left, one control or the
// row's buttons right (action()), read-only facts as a .dk-kv list.
import {
  h, icon, clear, append, fill, field, row, select, switchInput, pageHead, nextId,
} from '../components/dom.js';
import { confirmDialog } from '../components/dialog.js';
import { pinDialog, pinSummary } from '../components/pin.js';
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
  account: ['Account', 'The account this computer syncs with.'],
  security: ['Security', 'The app lock and how this computer keeps your key.'],
  updates: ['Updates', 'The installed version and how ONE.GY updates.'],
  about: ['About', 'Version details and diagnostics for support.'],
};
const SYNC_NOTIFY = [
  ['conflict', 'Conflicts', 'A file changed on this computer and on one.gy.'],
  ['issue', 'Sync issues', 'Something needs your decision in Issues.'],
  ['mass_delete', 'Large deletions', 'A sync paused before deleting many files.'],
  ['transfer', 'Completed transfers', 'Uploads and downloads finished.'],
];
const APP_NOTIFY = [
  ['revoked', 'Device removed', 'This computer was removed from your devices.'],
  ['info', 'Updates and news', 'New versions and other announcements.'],
];
const INHERITLESS = [['pause', 'Pause'], ['continue', 'Keep syncing']];

// The open settings page's render(): a failed save redraws it, so no control
// keeps showing a value that was not saved.
let rerenderPage = () => {};

async function saveApp(patch) {
  try {
    store.app = await appSettings.set(patch);
    toast('Saved', 'success', 1600);
    return true;
  } catch (err) {
    toastError(err);
    rerenderPage();
    return false;
  }
}

async function saveEngine(patch) {
  try {
    store.settings = await rpc('settings.set', { patch });
    toast('Saved', 'success', 1600);
    return true;
  } catch (err) {
    toastError(err);
    rerenderPage();
    return false;
  }
}

const button = (label, onclick, kind = 'ghost', iconName = null) => h('button', { type: 'button', class: `rd-btn rd-btn-${kind}`, onclick }, iconName ? icon(iconName) : null, label);

// A row whose control is one or more buttons. Not a <label> target, so clicking the text runs nothing.
const action = (label, hint, ...buttons) => row(label, hint, h('div', { class: 'dk-btn-row' }, buttons));

// A number box with its unit inside it (KB/s, days, …).
function num(value, min, max, onchange, unit) {
  const input = h('input', {
    type: 'number', class: 'form-input', min, max, value, inputmode: 'numeric',
    onchange: (e) => {
      const n = Math.min(max, Math.max(min, Math.round(Number(e.target.value)) || min));
      e.target.value = n;
      onchange(n);
    },
  });
  return h('div', { class: 'dk-numbox' }, input, unit ? h('span', { class: 'dk-numbox-unit', 'aria-hidden': 'true' }, unit) : null);
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
    case 'downloading': return [`Downloading version ${v}${u.progress ? ` (${u.progress}%)` : ''}…`, 'Downloading…', null];
    case 'available': return [`Version ${v} is available.`, 'Update and restart', 'installUpdate', true];
    case 'installing': return [`Installing ${v ? `version ${v}` : 'the update'}. ONE.GY restarts when it’s done.`, 'Installing…', null];
    case 'ready': return [`${v ? `Version ${v}` : 'A new version'} is ready. Restart to use it, and you’ll be back where you left off.`, 'Restart now', 'installUpdate', true];
    case 'error': return [u.error, u.failed === 'install' ? 'Try again' : 'Check for updates', u.failed === 'install' ? 'installUpdate' : 'checkForUpdates'];
    case 'current': return [`Up to date. Last checked ${ago(u.checked_at)}.`, 'Check for updates', 'checkForUpdates'];
    default: return ['Not checked yet.', 'Check for updates', 'checkForUpdates'];
  }
}

function updateRow() {
  const u0 = store.update || { supported: false };
  const hint = h('p', { class: 'rd-field-hint', 'aria-live': 'polite' });
  const btn = h('button', { type: 'button', class: 'rd-btn rd-btn-ghost', id: nextId('r') });
  let next = null;
  const paint = (u) => {
    const [text, label, step, primary] = u.supported ? updateStep(u) : ['This build doesn’t update itself.', 'Check for updates', null];
    hint.textContent = text;
    btn.textContent = label;
    btn.className = `rd-btn ${primary ? 'rd-btn-primary' : 'rd-btn-ghost'}`;
    btn.disabled = !step;
    next = step;
  };
  btn.addEventListener('click', async () => {
    if (!next) return;
    btn.disabled = true;
    try {
      store.update = await bridge(next);
    } catch (err) {
      toastError(err);
    }
    paint(store.update || u0);
  });
  const off = on('app:update', (u) => (hint.isConnected ? paint(u) : off()));
  paint(u0);
  return h('div', { class: 'rd-field-row' },
    h('div', { class: 'rd-field-text' },
      h('span', { class: 'rd-field-label' }, store.version ? `Version ${store.version.app}` : 'ONE.GY'),
      hint),
    btn);
}

function general() {
  const a = store.app;
  return [
    panel('Startup and window', null,
      row('Open at login', 'Start ONE.GY in the tray when you sign in to this computer.', switchInput(a.launch_at_login, (v) => saveApp({ launch_at_login: v }))),
      row('Start minimized', 'Open in the tray instead of showing the window.', switchInput(a.start_minimized, (v) => saveApp({ start_minimized: v }))),
      row('Keep running when the window is closed', 'Syncing continues in the tray. Quit from the tray menu.', switchInput(a.close_to_tray, (v) => saveApp({ close_to_tray: v }))),
      store.version && store.version.platform === 'linux'
        ? row('Place the status popover under the tray icon', 'GNOME on Wayland doesn’t let apps place their windows, so ONE.GY runs through XWayland there. Turn this off if text looks blurry with fractional scaling. Takes effect after a restart.',
          switchInput(a.linux_x11, (v) => saveApp({ linux_x11: v })))
        : null),
    notifyPanel(APP_NOTIFY, 'Sync notifications are in Sync › Settings › Notifications.'),
    server(),
  ];
}

function updates() {
  const a = store.app;
  // deb / rpm installs follow the stable releases (build/linux/update-system.sh).
  const system = store.update && ['deb', 'rpm'].includes(store.update.kind);
  return [
    panel('Software update', null,
      updateRow(),
      row('Check for updates automatically', system
        ? 'Checks every 30 minutes and asks before restarting. While ONE.GY is in the tray, it restarts on its own. The system also installs new versions in the background.'
        : 'Checks every 30 minutes, downloads in the background and asks before restarting. While ONE.GY is in the tray, it restarts on its own.',
      switchInput(a.auto_update, (v) => saveApp({ auto_update: v }))),
      system ? null : row('Update channel', 'Beta gets new versions first.', select([['stable', 'Stable'], ['beta', 'Beta']], a.update_channel, (v) => saveApp({ update_channel: v })))),
  ];
}

function notifyPanel(kinds, sub) {
  const a = store.app;
  return panel('Notifications', sub, ...kinds.map(([k, label, hint]) => row(label, hint, switchInput(a.notify[k], (v) => saveApp({ notify: { [k]: v } })))));
}

const notifications = () => [notifyPanel(SYNC_NOTIFY, 'Update and device notifications are in App settings › General.')];

function server() {
  const current = store.app.server_url;
  const input = h('input', { class: 'form-input', type: 'url', value: current, spellcheck: 'false' });
  const result = h('p', { class: 'rd-field-hint', 'aria-live': 'polite' });
  const check = button('Check and use', async () => {
    result.textContent = 'Checking…';
    const res = await bridge('probeServer', input.value).catch((e) => ({ ok: false, message: e.message }));
    result.textContent = res.message;
    if (!res.ok || res.origin === current) return;
    try {
      store.app = await appSettings.set({ server_url: res.origin });
    } catch (err) {
      result.textContent = `Could not save the address: ${err.message}`;
      return;
    }
    input.value = res.origin;
    result.textContent = `${res.message} The website now loads from ${res.origin}.`;
  });
  const form = h('div', { class: 'dk-row-form', hidden: true },
    h('p', { class: 'rd-field-hint' }, 'For self-hosted one.gy servers. The address must use https. Sync keeps using the server this computer was set up with until you sign out of sync.'),
    h('div', { class: 'dk-inline' }, field('New address', input), check),
    result);
  const toggle = button('Change…', () => {
    form.hidden = !form.hidden;
    toggle.textContent = form.hidden ? 'Change…' : 'Cancel';
    if (!form.hidden) input.focus();
  });
  return panel('Server', null, action('Server address', current, toggle), form);
}

function signOut() {
  return button('Sign out of sync', async () => {
    const ok = await confirmDialog({
      title: 'Sign out of sync on this computer?',
      message: 'Syncing stops, this computer is removed from your devices and its keys are deleted. Local files are kept.',
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
  }, 'danger');
}

function account() {
  const a = store.account;
  if (!a) return [panel('Account', null, h('p', { class: 'rd-field-hint' }, 'The sync engine isn’t running.'))];
  if (!a.signed_in) {
    return [panel('Account', null,
      action('Sync isn’t set up', 'Sign in and authorize this computer to start syncing.', button('Set up this computer', () => navigate('wizard'), 'primary')))];
  }
  const used = percent(a.storage_used, a.storage_limit);
  const meter = h('div', { class: 'rd-meter-fill' });
  meter.style.width = `${used}%`;
  return [
    panel('Account', null,
      h('dl', { class: 'dk-kv' },
        h('dt', null, 'Username'), h('dd', null, a.username),
        h('dt', null, 'Server'), h('dd', null, a.server),
        h('dt', null, 'Device name'), h('dd', null, a.device_name || '–'),
        h('dt', null, 'Storage'), h('dd', null, a.storage_limit > 0 ? `${bytes(a.storage_used)} of ${bytes(a.storage_limit)} used` : `${bytes(a.storage_used)} used`,
          a.storage_limit > 0 ? h('div', {
            class: 'rd-meter dk-kv-meter', role: 'progressbar', 'aria-label': 'Storage used', 'aria-valuenow': Math.round(used), 'aria-valuemin': 0, 'aria-valuemax': 100,
          }, meter) : null)),
      action('Account page', 'Your profile, password and devices on the website.', button('Open', () => navigate('close', { path: '/account' }), 'ghost', 'external'))),
    panel('Sign out', null,
      action('Sign out of sync on this computer', 'Syncing stops and this computer’s keys are deleted. Your files stay where they are, and the website stays signed in.', signOut())),
  ];
}

function defaults() {
  const s = store.settings;
  const d = s.defaults || {};
  const setDefault = (k) => (v) => saveEngine({ defaults: { ...d, [k]: v } }).then((ok) => { if (ok) Object.assign(d, { [k]: v }); });
  return [
    panel('Defaults for new syncs', 'New syncs start with these. Each sync can change them later in its own settings.',
      row('Sync type', 'Preselected when you add a sync.', select(['two_way', 'backup', 'mirror'].map((k) => [k, SYNC_TYPES[k].label]), d.type, setDefault('type'))),
      row('When a file changes on both sides', '“Prefer” options keep the other copy as an older version.', select([['keep_both', 'Keep both copies'], ['prefer_remote', 'Prefer one.gy'], ['prefer_local', 'Prefer this computer'], ['ask', 'Ask me']], d.conflict_policy, setDefault('conflict_policy'))),
      row('Issue handling', 'Smart fixes what is safe on its own. Advanced asks about everything.', select([['smart', 'Smart'], ['advanced', 'Advanced']], d.issue_mode, setDefault('issue_mode'))),
      row('Keep deleted files for', 'Set to 0 to send them straight to the system trash.', num(d.debris_days ?? 30, 0, 3650, setDefault('debris_days'), 'days')),
      row('Image thumbnails', 'Encrypted previews, so photos look the same on the website.', switchInput(d.thumbnails !== false, setDefault('thumbnails')))),
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
  const reset = (patch) => button('Always ask', () => saveApp(patch).then(rerender));
  const value = (text) => h('span', { class: 'dk-row-value dk-path', title: text }, text);
  const emptyDebris = async (s) => {
    const ok = await confirmDialog({
      title: `Empty deleted files of ${s.name}?`,
      message: 'The files this sync deleted or replaced on this computer are removed from its .onegy/debris folder for good.',
      confirmLabel: 'Empty', danger: true,
    });
    if (!ok) return;
    try {
      await rpc('syncs.clearDebris', { id: s.id });
      toast('Deleted files emptied', 'success');
    } catch (err) {
      toastError(err);
    }
  };
  const list = [...store.syncs.values()].sort((x, y) => String(x.name).localeCompare(String(y.name)));
  const upPath = up ? `one.gy${up.path === '/' ? '' : up.path}` : null;
  return [
    panel('Default folders', null,
      action('Upload folder on one.gy', 'Where Upload… in the tray puts files.',
        value(upPath || 'Ask every time'), button('Choose…', pick), up ? reset({ default_upload_folder: null }) : null),
      action('Download folder on this computer', 'Where downloads you start yourself are saved.',
        value(a.default_download_dir || 'Ask every time'), button('Choose…', pickDir), a.default_download_dir ? reset({ default_download_dir: '' }) : null)),
    panel('Deleted files', 'Files a sync deletes or replaces on this computer wait in its .onegy/debris folder for the days set in its settings.',
      ...(list.length
        ? list.map((s) => action(s.name, h('span', { class: 'dk-path', title: s.local_path }, s.local_path),
          h('button', {
            type: 'button', class: 'rd-btn rd-btn-ghost', 'aria-label': `Empty deleted files of ${s.name}`, onclick: () => emptyDebris(s),
          }, 'Empty')))
        : [h('p', { class: 'rd-field-hint' }, 'No syncs yet.')])),
  ];
}

function network() {
  const s = store.settings;
  const proxy = { mode: 'system', url: '', ...s.proxy };
  const proxyUrl = h('input', {
    class: 'form-input', value: proxy.url, placeholder: 'socks5://host:1080 or http://host:8080', spellcheck: 'false',
    onchange: (e) => saveEngine({ proxy: { mode: 'manual', url: e.target.value.trim() } }),
  });
  const proxyField = field('Proxy address', proxyUrl, 'If the proxy needs a username and password, include them in the address.');
  proxyField.hidden = proxy.mode !== 'manual';
  return [
    panel('Bandwidth', 'Set a limit to 0 for no limit.',
      row('Upload limit', null, num(s.upload_kbps, 0, 10000000, (v) => saveEngine({ upload_kbps: v }), 'KB/s')),
      row('Download limit', null, num(s.download_kbps, 0, 10000000, (v) => saveEngine({ download_kbps: v }), 'KB/s')),
      row('Simultaneous uploads', null, num(s.parallel_up, 1, 6, (v) => saveEngine({ parallel_up: v }))),
      row('Simultaneous downloads', null, num(s.parallel_down, 1, 6, (v) => saveEngine({ parallel_down: v })))),
    panel('Proxy', null,
      row('Connection', null, select([['none', 'No proxy'], ['system', 'System proxy settings'], ['manual', 'Manual proxy']], proxy.mode, (v) => {
        proxyField.hidden = v !== 'manual';
        if (v !== 'manual') saveEngine({ proxy: { mode: v, url: '' } });
      })),
      proxyField),
    panel('Power and data', 'Each sync can override the metered network and battery choices in its own settings.',
      row('On metered networks', 'Connections such as a phone hotspot or a capped data plan.', select(INHERITLESS, s.metered, (v) => saveEngine({ metered: v }))),
      row('On battery power', null, select(INHERITLESS, s.battery, (v) => saveEngine({ battery: v }))),
      row('Prevent sleep while syncing', 'Keeps this computer awake until syncing finishes.', switchInput(store.app.prevent_sleep, (v) => saveApp({ prevent_sleep: v })))),
  ];
}

function security(rerender) {
  const s = store.settings;
  const a = store.account || {};
  const openSite = (p) => () => navigate('close', { path: p });
  const pinActions = a.pin_set
    ? [
      button('Change PIN', async () => { if (await pinDialog({ title: 'Change PIN', strict: a.pin_strict })) rerender(); }),
      button('Remove PIN', async () => {
        if (!await confirmDialog({ title: 'Remove the PIN?', message: 'ONE.GY then asks for your password whenever it is locked.', confirmLabel: 'Remove PIN' })) return;
        try {
          store.account = await rpc('account.removePin');
          toast('PIN removed', 'success');
          rerender();
        } catch (err) {
          toastError(err);
        }
      })]
    : [button('Set up PIN', async () => { if (await pinDialog()) rerender(); })];
  return [
    panel('App lock', 'ONE.GY locks when it starts, when this computer sleeps or locks its screen, and after the idle time below. Syncing continues while it is locked.',
      action('Unlock with a PIN', pinSummary(a), ...pinActions),
      row('Lock when idle for', 'It always locks on start, sleep and screen lock.', select([[5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [240, '4 hours'], [0, 'Never']],
        store.app.lock_after_minutes, (v) => saveApp({ lock_after_minutes: Number(v) }))),
      a.lock_enabled ? action('Lock now', 'Lock ONE.GY until you unlock it with your PIN or password.', button('Lock now', () => bridge('lockNow').catch(toastError), 'ghost', 'lock')) : null),
    panel('This computer', null,
      row('Ask for my password when ONE.GY starts', 'Your key is then kept in memory only, never in the system key store.', switchInput(s.require_password_on_start, (v) => saveEngine({ require_password_on_start: v }))),
      row('Unlock the website with this computer’s key', 'Shows encrypted file names on the website without asking for your password. Scripts on one.gy in this app can then read the key, as they can in a browser where you are unlocked.',
        switchInput(s.web_unlock, (v) => saveEngine({ web_unlock: v }))),
      row('Request signing key', a.hardware_key ? 'Kept in this computer’s security chip (TPM), so a copy of the app data can’t be used on another computer.' : 'Kept in the system key store. This computer has no usable security chip.',
        h('span', { class: 'rd-pill' }, a.signed_requests ? (a.hardware_key ? 'Hardware' : 'Software') : 'Not created yet'))),
    panel('Account security', 'These open on the website.',
      action('Password', 'Change the password for your account.', button('Change password', openSite('/account'), 'ghost', 'external')),
      action('Recovery key', 'Export the key that restores your encrypted files if you forget your password.', button('Export recovery key', openSite('/account'), 'ghost', 'external')),
      action('Devices', 'See the devices that sync with your account and remove old ones.', button('Manage devices', openSite('/account/devices'), 'ghost', 'external'))),
  ];
}

function advanced() {
  const s = store.settings;
  return [
    panel('Deletion safety', 'A sync pauses and asks you first when it would delete more than either limit.',
      row('Number of items', null, num(s.mass_delete_count, 1, 1000000, (v) => saveEngine({ mass_delete_count: v }), 'items')),
      row('Share of the sync', null, num(s.mass_delete_percent, 1, 100, (v) => saveEngine({ mass_delete_percent: v }), '%'))),
    panel('Sync engine', null,
      row('Full rescan every', 'Catches changes the file watcher missed.', num(s.rescan_minutes, 5, 1440, (v) => saveEngine({ rescan_minutes: v }), 'minutes')),
      row('Check one.gy for changes at most every', 'Shorter waits pick up changes sooner but use more data.', num(s.poll_floor_seconds, 5, 3600, (v) => saveEngine({ poll_floor_seconds: v }), 'seconds')),
      row('Log level', 'Logs leave out file names unless set to Debug. Export them from App settings › About.',
        select([['error', 'Errors only'], ['warn', 'Warnings'], ['info', 'Normal'], ['debug', 'Debug']], s.log_level, (v) => saveEngine({ log_level: v })))),
    panel('Maintenance', null,
      action('Clear caches', 'Reloads the list of one.gy folders and the decrypted keys. Your files are not touched.', button('Clear caches', async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          await rpc('engine.clearCaches');
          toast('Caches cleared', 'success');
        } catch (err) {
          toastError(err);
        } finally {
          b.disabled = false;
        }
      }))),
  ];
}

// Works without the engine too: its rows then stay out.
function about() {
  const info = h('dl', { class: 'dk-kv' });
  const dataDir = h('span', { class: 'dk-path' }, 'Logs, settings and the sync database.');
  if (store.version) append(info, h('dt', null, 'ONE.GY Desktop'), h('dd', null, store.version.app), h('dt', null, 'Electron'), h('dd', null, store.version.electron));
  rpc('engine.info').then((e) => {
    append(info, h('dt', null, 'Sync engine'), h('dd', null, `${e.version} (protocol ${e.protocol})`));
    dataDir.textContent = e.state_dir;
    dataDir.title = e.state_dir;
  }).catch(() => {});
  return [
    panel('Version', null, info),
    panel('Diagnostics', null,
      action('Export diagnostics', 'A zip with logs and a redacted summary. Review it before you share it.', button('Export…', async () => {
        try {
          const res = await bridge('exportDiagnostics');
          if (res) toast('Diagnostics saved', 'success');
        } catch (err) {
          toastError(err);
        }
      })),
      action('Data folder', dataDir, button('Open', () => bridge('openDataFolder').catch(toastError)))),
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
    rerenderPage = render;
    if (tabs) {
      clear(tabs);
      for (const [id, label] of tabList) {
        append(tabs, h('button', {
          type: 'button', role: 'tab', class: 'rd-tab', 'aria-selected': String(tab === id),
          onclick: () => { tab = id; render(); },
        }, label));
      }
    }
    if (NEEDS_ENGINE.has(tab)) {
      try {
        store.settings = await rpc('settings.get');
      } catch (err) {
        fill(body, h('div', { class: 'rd-callout is-warn' }, icon('alert'), h('div', null, `These settings need the sync engine: ${err.message}`)));
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

  append(container, h('div', { class: 'dk-settings' }, pageHead(title, sub), tabs, body));
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
