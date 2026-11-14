// In-memory fake of the sync engine, `onegy daemon` (desktop/docs/engine-ipc.md), with seed data
// and live-looking events. No Node or DOM APIs, so it runs both behind the
// socket in dev/mock-engine.js and in a plain browser via dev/ui-stub.js.
(function (root) {
  'use strict';

  function fail(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    err.data = Object.assign({ code }, extra || {});
    throw err;
  }

  function createMockEngine(opts) {
    const o = Object.assign({ home: '/srv/alice', sep: '/', signedIn: true, platform: 'linux' }, opts);
    const listeners = new Set();
    const iso = (msAgo) => new Date(Date.now() - (msAgo || 0)).toISOString();
    const local = (...parts) => [o.home, ...parts].join(o.sep);
    let nextId = 100;

    const account = {
      signed_in: o.signedIn, locked: false, server: 'https://one.gy', username: o.signedIn ? 'alice' : null,
      device_id: o.signedIn ? 'd1f0c2' : null, device_name: o.signedIn ? 'alice-laptop' : null,
      storage_used: 18.4e9, storage_limit: 50e9, versioning: true,
    };

    const settings = {
      upload_kbps: 0, download_kbps: 0, parallel_up: 2, parallel_down: 2,
      proxy: { mode: 'system', url: '' }, metered: 'pause', battery: 'continue',
      poll_floor_seconds: 5, rescan_minutes: 60, log_level: 'info',
      require_password_on_start: false, web_unlock: true,
      mass_delete_count: 50, mass_delete_percent: 20,
      defaults: { type: 'two_way', conflict_policy: 'keep_both', issue_mode: 'smart', debris_days: 30, thumbnails: true },
    };

    const baseSync = {
      encryption: 'e2ee', hide_extensions: false, conflict_policy: 'keep_both', issue_mode: 'smart',
      propagate_deletes: true, debris_days: 30, schedule: { mode: 'live', interval_minutes: 15, window: null },
      limits: { upload_kbps: 0, download_kbps: 0 }, metered: 'inherit', battery: 'inherit',
      keep_exec_bit: true, include_hidden_system: false, thumbnails: true, paused: false, detail: '', waiting: false, retry_at: null, created_at: iso(86400000 * 20),
    };
    const syncs = new Map();
    const addSync = (s) => syncs.set(s.id, Object.assign({}, baseSync, s));
    if (o.signedIn && !o.empty) {
      addSync({ id: 's_work', name: 'Work', type: 'two_way', local_path: local('Work'), remote_folder_id: 12, remote_path: '/Work', state: 'syncing',
        stats: { pending_up: 3, pending_down: 1, bytes_left: 158334976, total_items: 9, total_bytes: 412334976, issues: 2, last_synced_at: iso(60000) } });
      addSync({ id: 's_photos', name: 'Photos', type: 'backup', local_path: local('Pictures'), remote_folder_id: 21, remote_path: '/Backups/alice-laptop/Pictures', state: 'up_to_date',
        stats: { pending_up: 0, pending_down: 0, bytes_left: 0, issues: 0, last_synced_at: iso(240000) } });
      addSync({ id: 's_music', name: 'Music', type: 'mirror', encryption: 'standard', local_path: local('Music'), remote_folder_id: 30, remote_path: '/Music', state: 'paused', paused: true,
        stats: { pending_up: 0, pending_down: 0, bytes_left: 0, issues: 1, last_synced_at: iso(86400000 * 2) } });
    }

    const transfers = new Map();
    const addTransfer = (t) => transfers.set(t.id, Object.assign({
      error: null, finished_at: null, manual: false, started_at: iso(30000), phase: t.state === 'active' ? 'transferring' : '', note: null, stalled: false,
    }, t));
    if (o.signedIn) {
      addTransfer({ id: 't_1', sync_id: 's_work', direction: 'up', path: 'reports/q3-final.pdf', size: 104857600, done: 52428800, bps: 4194304, state: 'active' });
      addTransfer({ id: 't_2', sync_id: 's_work', direction: 'down', path: 'design/mockups/home.fig', size: 48234496, done: 9437184, bps: 2097152, state: 'active' });
      addTransfer({ id: 't_3', sync_id: 's_work', direction: 'up', path: 'notes/meeting-2026-11-08.md', size: 4096, done: 0, bps: 0, state: 'queued' });
      addTransfer({ id: 't_4', sync_id: null, direction: 'up', path: 'holiday.mov', size: 734003200, done: 0, bps: 0, state: 'queued', manual: true });
      addTransfer({ id: 't_5', sync_id: 's_photos', direction: 'up', path: '2026/IMG_2041.jpg', size: 3407872, done: 3407872, bps: 0, state: 'done', finished_at: iso(120000) });
      addTransfer({ id: 't_6', sync_id: 's_work', direction: 'down', path: 'budget.xlsx', size: 88064, done: 0, bps: 0, state: 'failed', error: 'The file changed on one.gy while downloading. It will be retried.' });
    }

    const issues = new Map();
    const addIssue = (i) => issues.set(i.id, Object.assign({ created_at: iso(600000), local: null, remote: null }, i));
    if (o.signedIn) {
      addIssue({ id: 41, sync_id: 's_work', kind: 'conflict', path: 'notes/todo.txt', message: 'Changed on both this computer and one.gy.',
        local: { size: 1204, mtime: iso(3600000), sha256: 'ab12f9c03e77d1aa' }, remote: { size: 980, mtime: iso(5400000), sha256: 'cd34e1b8a0f2c9de' },
        actions: ['keep_both', 'keep_remote', 'keep_local', 'ignore'] });
      addIssue({ id: 42, sync_id: 's_work', kind: 'case_clash', path: 'Design/Logo.svg', message: 'one.gy has Logo.svg and logo.svg; this computer cannot hold both.',
        actions: ['rename', 'ignore', 'open'] });
      addIssue({ id: 43, sync_id: 's_music', kind: 'permission', path: 'Live/2019/set.flac', message: 'This computer does not allow writing here.',
        actions: ['retry', 'ignore', 'open'] });
    }

    const remote = {
      null: { folder: null, folders: [
        { type: 'folder', id: 12, parent_id: null, name: 'Work', is_e2e: true },
        { type: 'folder', id: 20, parent_id: null, name: 'Backups', is_e2e: true },
        { type: 'folder', id: 40, parent_id: null, name: 'Documents', is_e2e: true },
        { type: 'folder', id: 30, parent_id: null, name: 'Music', is_e2e: false },
      ], files: [
        { type: 'file', id: 'f-a1', folder_id: null, name: 'passport-scan.pdf', is_e2e: true, size: 2201000, size_plain: 2200960 },
      ] },
      12: { folder: { type: 'folder', id: 12, name: 'Work', is_e2e: true }, folders: [
        { type: 'folder', id: 13, parent_id: 12, name: 'reports', is_e2e: true },
        { type: 'folder', id: 14, parent_id: 12, name: 'design', is_e2e: true },
      ], files: [
        { type: 'file', id: 'f-b1', folder_id: 12, name: 'budget.xlsx', is_e2e: true, size: 88101, size_plain: 88064 },
        { type: 'file', id: 'f-b2', folder_id: 12, name: 'roadmap.md', is_e2e: true, size: 6177, size_plain: 6140 },
      ] },
      20: { folder: { type: 'folder', id: 20, name: 'Backups', is_e2e: true }, folders: [
        { type: 'folder', id: 21, parent_id: 20, name: 'alice-laptop', is_e2e: true },
      ], files: [] },
    };

    // A pretend local folder for syncs.browse, whatever path is asked for.
    const localTree = {
      '': [['src', 'folder'], ['docs', 'folder'], ['node_modules', 'folder'], ['build', 'folder'], ['.git', 'folder'],
        ['README.md', 'file', 4200], ['demo-recording.mp4', 'file', 2.4e9], ['notes.txt', 'file', 900], ['Thumbs.db', 'file', 12000]],
      src: [['components', 'folder'], ['__pycache__', 'folder'], ['main.js', 'file', 18000], ['util.js', 'file', 5300], ['debug.log', 'file', 81000]],
      docs: [['drafts', 'folder'], ['guide.pdf', 'file', 1.2e6], ['logo.png', 'file', 64000]],
      'src/components': [['Button.js', 'file', 2100], ['Menu.js', 'file', 3400]],
    };
    // Roughly the engine's matcher: name globs, -d: folders, exact -pR:/+pR: paths, exclude-larger.
    function mockMatch(text, path, kind, size) {
      let verdict = null;
      let larger = -1;
      const name = path.split('/').pop();
      const glob = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
      for (const line of String(text || '').split('\n')) {
        let m = /^exclude-larger:(\d+)([KMG]?)$/i.exec(line);
        if (m) { larger = Number(m[1]) * ({ k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()] || 1); continue; }
        m = /^([-+])pR:(.*)$/.exec(line);
        if (m) { if (m[2].replace(/\\(.)/g, '$1') === path) verdict = m[1] === '-'; continue; }
        m = /^([-+])(d?):(.+)$/.exec(line);
        if (m && (!m[2] || kind === 'folder') && glob(m[3]).test(name)) verdict = m[1] === '-';
      }
      return { excluded: verdict === true, size_skipped: verdict === null && kind === 'file' && larger >= 0 && size > larger };
    }

    function emit(type, data) {
      for (const fn of listeners) fn({ type, data: JSON.parse(JSON.stringify(data)) });
    }

    function overall() {
      const list = [...transfers.values()];
      const active = list.filter((t) => t.state === 'active');
      let state = 'up_to_date';
      if (!account.signed_in) state = 'signed_out';
      else if (account.locked) state = 'locked';
      else if (issues.size) state = 'issues';
      else if (active.length) state = 'syncing';
      else if ([...syncs.values()].length && [...syncs.values()].every((s) => s.paused)) state = 'paused';
      return {
        state,
        pending: list.filter((t) => t.state === 'active' || t.state === 'queued').length,
        bps_up: active.filter((t) => t.direction === 'up').reduce((n, t) => n + t.bps, 0),
        bps_down: active.filter((t) => t.direction === 'down').reduce((n, t) => n + t.bps, 0),
      };
    }

    function needSignedIn() {
      if (!account.signed_in) fail('not_signed_in', 'This computer is not set up for sync.');
    }
    function getSync(id) {
      const s = syncs.get(id);
      if (!s) fail('not_found', 'No such sync.');
      return s;
    }
    const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

    const methods = {
      'engine.info': () => ({ version: '0.1.0-mock', protocol: 1, state_dir: local('.local', 'share', 'onegy'), platform: o.platform }),
      'ipc.hello': () => ({}), // like the engine without --ipc-secret-stdin
      'engine.subscribe': () => ({}),
      'engine.shutdown': () => ({}),
      'engine.nudge': () => ({}),
      'account.status': () => Object.assign({}, account),
      'account.authorize': (p) => {
        if (!p.username || !p.password) fail('validation_failed', 'Username and password are required.');
        if (p.password === 'wrong') fail('invalid_credentials', 'Wrong username or password.');
        if (p.username === 'totp' && !p.totp_code) fail('totp_required', 'Two-factor code required.');
        Object.assign(account, { signed_in: true, locked: false, server: p.server, username: p.username, device_id: 'd9', device_name: p.device_name });
        emit('status', overall());
        return Object.assign({}, account);
      },
      'account.unlock': (p) => {
        if (p.password === 'wrong') fail('invalid_credentials', 'Wrong password.');
        account.locked = false;
        return Object.assign({}, account);
      },
      'account.signOut': () => {
        Object.assign(account, { signed_in: false, username: null, device_id: null, device_name: null });
        for (const s of syncs.values()) s.paused = true;
        emit('status', overall());
        return {};
      },
      'account.webUnlockKey': () => {
        needSignedIn();
        if (!settings.web_unlock) fail('locked', 'Website unlock is off.');
        return { master_key_b64: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i))) };
      },
      'remote.list': (p) => {
        needSignedIn();
        const key = p && p.folder_id !== undefined && p.folder_id !== null ? p.folder_id : 'null';
        const hit = remote[key];
        if (!hit) return { folder: { type: 'folder', id: p.folder_id, name: 'Folder' }, folders: [], files: [] };
        return JSON.parse(JSON.stringify(hit));
      },
      'remote.createFolder': (p) => {
        needSignedIn();
        if (!p.name || /[\\/]/.test(p.name)) fail('validation_failed', 'Folder names cannot contain slashes.');
        const node = { type: 'folder', id: nextId++, parent_id: p.parent_id, name: p.name, is_e2e: p.e2ee !== false };
        const key = p.parent_id === null || p.parent_id === undefined ? 'null' : p.parent_id;
        (remote[key] = remote[key] || { folder: null, folders: [], files: [] }).folders.push(node);
        remote[node.id] = { folder: node, folders: [], files: [] };
        return node;
      },
      'syncs.list': () => [...syncs.values()],
      'syncs.validate': (p) => {
        needSignedIn();
        const errors = [];
        const warnings = [];
        const path = String(p.local_path || '');
        if (!path) errors.push({ code: 'missing', message: 'Choose a folder.' });
        if (path === '/' || /^[A-Za-z]:\\?$/.test(path)) errors.push({ code: 'system_path', message: 'A whole drive or system folder cannot be synced.' });
        for (const s of syncs.values()) {
          if (path && (path === s.local_path || path.startsWith(s.local_path + o.sep) || s.local_path.startsWith(path + o.sep))) {
            errors.push({ code: 'local_overlap', message: `Overlaps with the sync "${s.name}" (${s.local_path}).` });
          }
          if ('remote_folder_id' in p && p.type !== 'mirror' && s.type !== 'mirror' && p.remote_folder_id === s.remote_folder_id) {
            errors.push({ code: 'remote_overlap', message: `The one.gy folder is already used by "${s.name}".` });
          }
        }
        if (/dropbox|onedrive|google drive/i.test(path)) warnings.push({ code: 'other_client', message: 'This folder is inside another sync app. Two sync apps on one folder fight over changes.' });
        const out = {
          ok: errors.length === 0, errors, warnings,
          fs: { kind: o.platform === 'win32' ? 'NTFS' : 'ext4', case_sensitive: o.platform !== 'win32', free_bytes: 212e9 },
          local: { files: 1203, bytes: 4.2e9 },
        };
        if ('remote_folder_id' in p) out.remote = p.remote_folder_id === 12 ? { files: 88, bytes: 3e8 } : { files: 0, bytes: 0 };
        return out;
      },
      'syncs.preview': (p) => {
        needSignedIn();
        if (!p.config || !p.config.local_path) fail('validation_failed', 'config.local_path is required.');
        const items = [];
        for (let i = 0; i < 24; i++) items.push({ action: i % 5 === 0 ? 'download' : 'upload', path: `docs/file-${String(i).padStart(3, '0')}.txt`, size: 1024 * (i + 1) });
        const deletions = p.initial === 'local_source' ? 4 : 0;
        return { uploads: { count: 1203, bytes: 4.2e9 }, downloads: { count: p.initial === 'local_source' ? 0 : 88, bytes: 3e8 }, conflicts: p.initial === 'merge' ? 3 : 0, deletions, items };
      },
      'syncs.create': (p) => {
        needSignedIn();
        const id = `s_${nextId++}`;
        const cfg = Object.assign({}, p.config);
        delete cfg.ignore_rules;
        addSync(Object.assign(cfg, { id, state: 'scanning', stats: { pending_up: 0, pending_down: 0, bytes_left: 0, issues: 0, last_synced_at: null } }));
        emit('sync', syncs.get(id));
        return syncs.get(id);
      },
      'syncs.update': (p) => {
        const s = getSync(p.id);
        Object.assign(s, pick(p.patch || {}, ['name', 'conflict_policy', 'issue_mode', 'propagate_deletes', 'debris_days', 'schedule', 'limits', 'metered', 'battery', 'keep_exec_bit', 'include_hidden_system', 'thumbnails']));
        emit('sync', s);
        return s;
      },
      'syncs.remove': (p) => { getSync(p.id); syncs.delete(p.id); return {}; },
      'syncs.browse': (p) => {
        const rel = p.path || '';
        const byName = new Map();
        if (p.local_path) for (const [name, kind, size] of localTree[rel] || []) byName.set(name, { name, kind, size: size || 0, local: true, remote: false });
        if ('remote_folder_id' in p) {
          const hit = remote[p.remote_folder_id === null || p.remote_folder_id === undefined ? 'null' : p.remote_folder_id];
          for (const n of [...((hit && hit.folders) || []), ...((hit && hit.files) || [])]) {
            const it = byName.get(n.name) || { name: n.name, kind: n.type, size: n.size_plain || 0, local: false };
            it.remote = true;
            if (n.type === 'folder') it.remote_id = n.id;
            byName.set(n.name, it);
          }
        }
        const ancestors = rel ? rel.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')) : [];
        const parentOut = ancestors.some((a) => mockMatch(p.ignore_rules, a, 'folder', 0).excluded);
        const items = [...byName.values()].map((it) => {
          const path = rel ? `${rel}/${it.name}` : it.name;
          const m = mockMatch(p.ignore_rules, path, it.kind, it.size);
          return Object.assign(it, { path, excluded: parentOut || m.excluded, size_skipped: !parentOut && m.size_skipped });
        }).sort((a, b) => (a.kind === b.kind ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : a.kind === 'folder' ? -1 : 1));
        return { items, errors: [], more: 0, folder_excluded: parentOut };
      },
      'syncs.backupTarget': (p) => {
        needSignedIn();
        const name = String(p.local_path || '').split(/[\\/]/).filter(Boolean).pop() || 'Folder';
        const path = `/Backups/${account.device_name}/${name}`;
        return { folder_id: p.create ? 22 : null, path, exists: Boolean(p.create) }; // 21 is Photos' backup
      },
      'syncs.clearDebris': (p) => { getSync(p.id); return {}; },
      'engine.clearCaches': () => ({}),
      'versions.list': (p) => {
        getSync(p.sync_id);
        return { file_id: 'f-b1', folder_id: 12, content_version: 3, versions: [
          { version_id: 'v2', content_version: 2, size: 87000, created_at: iso(3600000), same_key: true },
          { version_id: 'v1', content_version: 1, size: 85000, created_at: iso(86400000), same_key: true },
        ] };
      },
      'versions.restore': (p) => { getSync(p.sync_id); return { type: 'file', id: 'f-b1', name: p.path, content_version: 4 }; },
      'syncs.pause': (p) => {
        for (const s of p && p.id ? [getSync(p.id)] : syncs.values()) { s.paused = true; s.state = 'paused'; emit('sync', s); }
        emit('status', overall());
        return {};
      },
      'syncs.resume': (p) => {
        for (const s of p && p.id ? [getSync(p.id)] : syncs.values()) { s.paused = false; s.state = 'up_to_date'; emit('sync', s); }
        emit('status', overall());
        return {};
      },
      'syncs.syncNow': (p) => { getSync(p.id); return {}; },
      'syncs.verify': (p) => { getSync(p.id); return { matches: 1203, differs: 0, missing: 0 }; },
      'syncs.ignoreRules': (p) => { const s = getSync(p.id); return { text: s.ignore_text || '-:*.tmp\n-:Thumbs.db\n' }; },
      'syncs.setIgnoreRules': (p) => {
        const s = getSync(p.id);
        const errors = [];
        String(p.text || '').split('\n').forEach((line, i) => {
          if (line.trim() && !/^[-+#]/.test(line.trim())) errors.push({ line: i + 1, message: 'A rule starts with - (exclude) or + (include).' });
        });
        if (!errors.length) s.ignore_text = p.text;
        return { ok: errors.length === 0, errors };
      },
      'transfers.list': (p) => [...transfers.values()].filter((t) => !p || !p.state || t.state === p.state),
      'transfers.pause': (p) => {
        for (const t of transfers.values()) {
          if ((p.id && t.id !== p.id) || (p.direction && t.direction !== p.direction)) continue;
          if (t.state === 'active' || t.state === 'queued') { t.state = 'paused'; t.bps = 0; emit('transfer', t); }
        }
        return {};
      },
      'transfers.resume': (p) => {
        for (const t of transfers.values()) {
          if ((p.id && t.id !== p.id) || (p.direction && t.direction !== p.direction)) continue;
          if (t.state === 'paused') { t.state = 'active'; t.bps = 1048576; emit('transfer', t); }
        }
        return {};
      },
      'transfers.cancel': (p) => {
        const t = transfers.get(p.id);
        if (!t) fail('not_found', 'No such transfer.');
        if (!t.manual) fail('validation_failed', 'Sync transfers can be paused, not cancelled.');
        t.state = 'cancelled';
        t.bps = 0;
        emit('transfer', t);
        return {};
      },
      'transfers.clearCompleted': () => {
        for (const [id, t] of transfers) if (t.state === 'done') transfers.delete(id);
        return {};
      },
      'issues.list': (p) => [...issues.values()].filter((i) => !p || !p.sync_id || i.sync_id === p.sync_id),
      'issues.resolve': (p) => {
        const i = issues.get(p.id);
        if (!i) fail('not_found', 'No such issue.');
        if (!i.actions.includes(p.action)) fail('validation_failed', 'That action does not apply.');
        issues.delete(p.id);
        emit('issue', Object.assign({}, i, { resolved: true }));
        emit('status', overall());
        return {};
      },
      'issues.resolveAll': (p) => {
        let resolved = 0;
        for (const [id, i] of issues) {
          if (p && p.sync_id && i.sync_id !== p.sync_id) continue;
          issues.delete(id);
          emit('issue', Object.assign({}, i, { resolved: true }));
          resolved++;
        }
        emit('status', overall());
        return { resolved };
      },
      'settings.get': () => JSON.parse(JSON.stringify(settings)),
      'settings.set': (p) => {
        const patch = (p && p.patch) || {};
        for (const [k, v] of Object.entries(patch)) {
          if (!(k in settings)) fail('validation_failed', `Unknown setting ${k}.`);
          settings[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? Object.assign({}, settings[k], v) : v;
        }
        return JSON.parse(JSON.stringify(settings));
      },
      'manual.upload': (p) => {
        needSignedIn();
        const ids = (p.paths || []).map((path) => {
          const id = `t_${nextId++}`;
          addTransfer({ id, sync_id: null, direction: 'up', path: String(path).split(/[\\/]/).pop(), size: 5e6, done: 0, bps: 0, state: 'queued', manual: true });
          emit('transfer', transfers.get(id));
          return id;
        });
        return { transfer_ids: ids };
      },
      'manual.download': (p) => {
        needSignedIn();
        const ids = (p.remote_ids || []).map((rid) => {
          const id = `t_${nextId++}`;
          addTransfer({ id, sync_id: null, direction: 'down', path: `download-${rid}`, size: 2e6, done: 0, bps: 0, state: 'queued', manual: true });
          emit('transfer', transfers.get(id));
          return id;
        });
        return { transfer_ids: ids };
      },
      'activity.recent': (p) => [
        { at: iso(60000), sync_id: 's_work', action: 'Uploaded', path: 'reports/q2.pdf' },
        { at: iso(180000), sync_id: 's_photos', action: 'Backed up', path: '2026/IMG_2040.jpg' },
      ].slice(0, (p && p.limit) || 20),
      'diagnostics.export': (p) => ({ path: p.path }),
    };

    // Moves active transfers along and promotes queued ones. Call ~1/s.
    function tick() {
      let activeCount = 0;
      for (const t of transfers.values()) {
        if (t.state !== 'active') continue;
        t.done = Math.min(t.size, t.done + t.bps);
        if (t.done >= t.size) {
          t.state = 'done';
          t.phase = '';
          t.bps = 0;
          t.finished_at = iso(0);
          emit('activity', { at: t.finished_at, sync_id: t.sync_id, action: t.direction === 'up' ? 'Uploaded' : 'Downloaded', path: t.path });
          if (t.size > 50e6) emit('notify', { title: 'Transfer finished', body: t.path, kind: 'transfer' });
        } else {
          activeCount++;
        }
        emit('transfer', t);
      }
      for (const t of transfers.values()) {
        if (activeCount >= 2) break;
        if (t.state === 'queued') {
          t.state = 'active';
          t.phase = 'transferring';
          t.bps = 3145728;
          activeCount++;
          emit('transfer', t);
        }
      }
      emit('status', overall());
    }

    return {
      call(method, params) {
        const fn = methods[method];
        if (!fn) fail('not_found', `Unknown method ${method}`);
        return fn(params || {});
      },
      onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      tick,
      overall,
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createMockEngine };
  else root.OnegyMock = { createMockEngine };
}(typeof globalThis !== 'undefined' ? globalThis : this));
