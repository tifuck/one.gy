# Engine IPC (desktop app ↔ `onegy daemon`), protocol 1

The contract between `client/internal/ipc` (server; the engine is the
`onegy daemon` subcommand of `client/cmd/onegy`) and
`desktop/app/src/main/engine.js` (client). Change both sides together.

## Transport

- Linux: Unix socket `$XDG_RUNTIME_DIR/onegy/engine.sock` (dir 0700, socket
  0600). Without `XDG_RUNTIME_DIR`: `<state dir>/run/engine.sock`.
- Windows: named pipe `\\.\pipe\onegy-engine-<USERNAME>`, DACL = current user only
  (the pipe keeps its name from before the engine became `onegy daemon`).
- Framing: one JSON object per line (`\n`-terminated, UTF-8). JSON-RPC 2.0.
- The engine also accepts `--socket <path>` (tests, multiple instances) and
  writes `<state dir>/engine.json` `{"pid", "socket", "version", "hello_key"}`
  (0600) once listening; the `onegy` CLI connects to the socket named there and
  first calls `ipc.hello {"nonce"}`: unless `key_proof` is
  `hex(HMAC-SHA256(hello_key, "onegy-engine-hello:" + nonce))` it sends nothing
  (no password) to a program squatting the socket or pipe name. Clients also
  refuse a socket whose server is another OS user (Linux `SO_PEERCRED`, Windows
  pipe server process token).
- State dir: Windows `%APPDATA%\ONE.GY`, Linux `$XDG_DATA_HOME/onegy`
  (default `~/.local/share/onegy`). Overridable with `--state-dir`.
- The app's own connection: the app starts the engine with `--ipc-stdio` and
  speaks the same framing on the engine's stdin (requests) and stdout (answers
  and events); the engine logs to its file and to stderr only. That connection
  is trusted without `ipc.hello`, and nothing can take its place: no name to
  squat and no secret to relay. When it ends (the app quit or crashed) the
  engine stops, so no engine outlives its app. With the flag the socket or pipe
  stays open for `ipc.hello {"nonce"}`, `engine.info` and `engine.shutdown`
  only; everything else there is `forbidden` (the `onegy` CLI cannot drive
  the app's engine). An engine the app did not start (left by an older
  version, or `onegy daemon` run by hand) holds the state dir: the app's own
  exits at once, the app asks the other over the socket to shut down and tries
  again. Without the flag (the headless daemon, tests, `onegy ipc`) every
  socket connection is trusted.
- On its way out the engine drops its unlock grant on the server (5 s at
  most), which ends the website session of this device: the next start asks
  for the PIN or password again, and the session of the run before is dead.

## Errors

JSON-RPC error `{"code": <int>, "message": "<human text>", "data": {"code": "<string code>"}}`.
String codes: `not_signed_in`, `locked` (key not unlocked), `app_locked` (the app
lock is on: unlock with the PIN or password first), `invalid_credentials`,
`totp_required`, `invalid_totp`, `captcha_required`, `device_revoked`,
`invalid_pin`, `pin_locked`, `pin_expired`, `pin_not_set`, `pin_required`,
`password_required`, `rate_limited`, `forbidden`,
`validation_failed` (`data.errors`), `not_found`, `offline`, `server_error`,
`internal`.
Numeric `code`: `-32700` parse error, `-32600` invalid request, `-32601` unknown
method (`not_found`), `-32602` invalid params (`validation_failed`), `-32000` every
application error. Clients branch on `data.code`, not on the number.
`data.errors` items are `{"code", "field"?, "message"}`.

## Objects

**Sync**
```json
{"id": "s_8f2c", "name": "Work", "type": "two_way",
 "local_path": "D:\\Work", "remote_folder_id": 12, "remote_path": "/Work",
 "encryption": "e2ee", "hide_extensions": false,
 "conflict_policy": "keep_both", "issue_mode": "smart",
 "propagate_deletes": true, "debris_days": 30,
 "schedule": {"mode": "live", "interval_minutes": 15, "window": null},
 "limits": {"upload_kbps": 0, "download_kbps": 0},
 "metered": "inherit", "battery": "inherit",
 "keep_exec_bit": true, "thumbnails": true, "include_hidden_system": false,
 "state": "syncing", "paused": false,
 "detail": "", "waiting": false, "retry_at": null,
 "stats": {"pending_up": 3, "pending_down": 0, "bytes_left": 1048576,
           "total_items": 12, "total_bytes": 9437184,
           "issues": 1, "last_synced_at": "2026-11-08T14:32:00Z"},
 "created_at": "…"}
```
- `stats.pending_*` / `bytes_left`: what is left, counted down while the work
  runs (`bytes_left` includes the bytes transfers under way have moved).
  `total_*`: what this run of work covers (left + finished since the sync last
  had nothing to do; 0 when idle), so `1 - bytes_left / total_bytes` is how far
  it is.
- `detail`: one sentence on why the sync is not getting on (`waiting: true`:
  failed changes waiting for another try with the last error, files still
  changing, storage or disk full, offline with the cause, keys locked, metered
  or battery policy, a transfer that waits or stopped moving) or on what it is
  busy with when no transfer shows it (`waiting: false`: folders, moves,
  deletes, `n of m`). `""` = nothing to add to `state`. `retry_at`: when a
  waiting sync looks again (null = not at a set time).
- `type`: `two_way` | `backup` | `mirror` (download only) | `archive` (upload, no deletes) | `full` (two-way on drive root).
- `encryption`: `e2ee` | `standard`. Fixed after create.
- `conflict_policy`: `keep_both` | `prefer_remote` | `prefer_local` | `ask`.
- `issue_mode`: `smart` | `advanced`.
- `metered` / `battery`: `inherit` | `pause` | `continue`.
- `keep_exec_bit`: the executable bit travels in the encrypted meta; a bit-only
  change rewrites the meta (or chmods here) without a content transfer.
- `include_hidden_system`: also sync items with the Windows hidden or system
  attribute (default `false`: they are excluded like `.onegyignore` matches).
- `schedule.mode`: `live` | `interval` | `window` | `manual`; `window` = `{"from": "22:00", "to": "06:00"}`.
- `state`: `scanning` | `syncing` | `up_to_date` | `paused` | `offline` | `error` | `root_missing` | `stalled`.

**Transfer**
```json
{"id": "t_91", "sync_id": "s_8f2c|null", "direction": "up", "path": "reports/q3.pdf",
 "size": 104857600, "done": 52428800, "bps": 4194304, "state": "active",
 "phase": "transferring", "note": null, "stalled": false,
 "error": null, "started_at": "…", "finished_at": null, "manual": false}
```
`state`: `queued` | `active` | `paused` | `done` | `failed` | `cancelled`.
`cancelled` also covers sync transfers dropped because the plan changed or the
sync was paused (they are re-planned); `error` is set only for `failed`.
`phase` (while `active`, else `""`): `preparing` (the local file is read,
hashed and encrypted; `done` counts those bytes and starts over when the
transfer begins) | `transferring` (`done` follows the bytes on the wire, also
inside one request) | `finishing` (upload sent and one.gy saves it; download
received and checked) | `retrying` (waits before another attempt).
`note`: why it waits (`retrying`: rate limited, server busy, connection
problem, no answer, with the delay) or that nothing moved for how long (after
10 s; the engine gives a request up after 2 minutes without a byte, 30 for
answers the server works on long). `stalled`: no sign of life for 30 s.
The engine keeps the last 500 finished transfers.

**Issue**
```json
{"id": 41, "sync_id": "s_8f2c", "kind": "conflict", "path": "notes/todo.txt",
 "message": "Changed on both this computer and one.gy.",
 "local": {"size": 120, "mtime": "…", "sha256": "ab12…"},
 "remote": {"size": 98, "mtime": "…", "sha256": "cd34…"},
 "actions": ["keep_both", "keep_remote", "keep_local", "ignore"],
 "created_at": "…"}
```
`kind`: `conflict`, `name_clash`, `case_clash`, `invalid_name`, `path_too_long`,
`symlink`, `permission`, `locked`, `quota`, `ignore_parse`, `read_only`,
`mass_delete`, `root_missing`, `remote_root_missing`, `disk_full`, `integrity`,
`too_large`, `watch_limit`, `sync_error` (an op keeps failing, or a plan repeats
without progress and the sync is `stalled`).
`actions` ⊆ `keep_both`, `keep_remote`, `keep_local`, `rename`, `retry`,
`ignore`, `delete_remote`, `restore_local`, `restore_remote_root`, `remove_sync`, `open`.

**Settings** (engine-owned; the app owns window/autostart/theme settings itself)
```json
{"upload_kbps": 0, "download_kbps": 0, "parallel_up": 2, "parallel_down": 2,
 "proxy": {"mode": "system", "url": ""}, "metered": "pause", "battery": "continue",
 "poll_floor_seconds": 5, "rescan_minutes": 60, "log_level": "info",
 "require_password_on_start": false, "web_unlock": true, "windows_explorer_status": false,
 "mass_delete_count": 50, "mass_delete_percent": 20,
 "defaults": {"type": "two_way", "conflict_policy": "keep_both",
              "issue_mode": "smart", "debris_days": 30, "thumbnails": true}}
```

`windows_explorer_status` (Windows, experimental, default off): see "File manager
integration".

`proxy.mode`: `system` | `none` | `manual` (`url` = `http://`, `https://` or
`socks5://host:port`). `settings.set` takes a JSON merge patch (nested objects
merge); unknown keys are rejected.

## Methods

| Method | Params | Result |
|---|---|---|
| `engine.info` | — | `{"version", "protocol": 1, "state_dir", "platform"}` |
| `engine.shutdown` | — | `{}`; engine reaches a safe point, then exits |
| `engine.nudge` | — | `{}`; poll the server now |
| `engine.environment` | `{"on_battery": bool, "metered": bool}` | `{}`; the app reports power/network changes; syncs whose (inherited) `battery`/`metered` policy is `pause` pause while it holds |
| `engine.clearCaches` | — | `{}`; drops unwrapped keys, cached capabilities and the remote tree cache, then takes a new snapshot |
| `account.status` | — | `{"signed_in", "locked", "full_keys", "app_locked", "lock_enabled", "pin_set", "pin_expires_at", "pin_strict", "pin_attempts_left", "pin_erased_at", "system_unlock", "system_unlock_available", "signed_requests", "hardware_key", "server", "username", "user_id", "device_id", "device_name", "storage_used", "storage_limit", "versioning"}` (see "App lock"; `versioning`: one.gy keeps previous versions on replace, from `GET /apiv1/me`) |
| `account.authorize` | `{"server", "username", "password", "totp_code"?, "device_name"}` | `account.status`; the app is left unlocked so a PIN can be chosen |
| `account.unlock` | `{"password", "new_pin"?, "pin_strict"?}` | `account.status`; opens the password-sealed keys (works offline), then unlocks the app online; `new_pin` (opt-in) also sets the PIN, validated before anything changes |
| `account.appUnlock` | `{"pin"}` | `account.status`; errors `invalid_pin` (re-read `pin_attempts_left`), `pin_locked`, `pin_expired`, `pin_not_set` (use `account.unlock`) |
| `account.appLock` | — | `account.status`; drops the grant (sync goes on inside the scope) |
| `account.setPin` | `{"pin", "strict", "current_pin"?, "password"?}` | `account.status`; app unlocked; 4 to 16 letters or digits, not easy to guess (repeats, runs, common PINs); `current_pin` or `password` unless the password was entered here in the last 10 minutes, else `credential_required`; a wrong one: `invalid_pin` (counts toward the five) or `invalid_credentials` |
| `account.removePin` | `{"current_pin"?, "password"?}` | `account.status`; app unlocked; same credential rule as `account.setPin`; the lock then asks for the password |
| `account.enableSystemUnlock` | `{"current_pin"?, "password"?}` | `account.status`; app unlocked; same credential rule as `account.setPin`; turns on `system_unlock_available` (Windows Hello creates its key, a fingerprint is checked once); `unavailable`, `cancelled`, `no_match` |
| `account.disableSystemUnlock` | — | `account.status`; app unlocked |
| `account.systemUnlock` | — | `account.status`; Windows Hello or a fingerprint; errors `cancelled` (not a failure), `no_match` (a wrong finger: counts as a failed unlock), `system_unlock_failed`, `pin_locked`, `pin_expired`, `system_unlock_not_set` |
| `account.signOut` | `{"revoke": true}` | `{}`; pauses syncs, wipes keys, keeps files |
| `account.webSession` | — | `{"ticket", "url"}` (main process only): load `url` with header `X-Onegy-Desktop-Ticket: <ticket>` to sign the site view in; `app_locked` while locked |
| `account.webUnlockKey` | — | `{"master_key_b64"}` or error `locked`; only when `web_unlock` and the app is unlocked (`app_locked` otherwise) |
| `remote.list` | `{"folder_id": null}` | `{"folder": node|null, "folders": [...], "files": [...]}`, names decrypted, + `size_plain` |
| `remote.createFolder` | `{"parent_id", "name", "e2ee": true}` | folder node |
| `syncs.list` | — | `[Sync]` |
| `syncs.validate` | `{"local_path", "remote_folder_id"?, "type", "initial"?}`; `remote_folder_id` omitted (not `null`, which is the drive root) = local checks only, no `remote` in the result | `{"ok", "errors": [{"code","message"}], "warnings": [...], "fs": {"kind","case_sensitive","free_bytes"}, "local": {"files","bytes"}, "remote": {"files","bytes"}}` |
| `syncs.preview` | `{"config": Sync-without-id, "initial": "merge"|"local_source"|"remote_source"}`; `config.ignore_rules` (optional string) = `.onegyignore` text that applies from the first scan; `syncs.create` writes it to the root | `{"uploads": {"count","bytes"}, "downloads": {"count","bytes"}, "conflicts", "deletions", "items": [{"action","path","size"}] (≤200)}` |
| `syncs.create` | `{"config", "initial"}`; `config.ignore_rules` as for preview (else the defaults, unless the folder already has a `.onegyignore`) | `Sync` |
| `syncs.update` | `{"id", "patch"}` | `Sync` |
| `syncs.remove` | `{"id", "release_backup"?: false}` | `{}`; never deletes local files; `release_backup` turns a backup sync's one.gy folder into a normal folder first |
| `syncs.backupTarget` | `{"local_path", "create"?: false}` | `{"folder_id": int|null, "path": "/Backups/<device>/<folder>", "exists"}`; `create` makes the missing E2EE folders (idempotent) |
| `syncs.clearDebris` | `{"id"}` | `{}`; deletes the sync's `.onegy/debris` now |
| `syncs.pause` / `syncs.resume` | `{"id"?}` (none = all) | `{}` |
| `syncs.syncNow` | `{"id"}` | `{}` |
| `syncs.verify` | `{"id"}` | `{"matches","differs","missing"}` (async; progress via events) |
| `syncs.ignoreRules` | `{"id"}` | `{"text"}` (contents of `.onegyignore`) |
| `syncs.setIgnoreRules` | `{"id", "text"}` | `{"ok", "errors": [{"line","message"}]}` |
| `syncs.browse` | `{"local_path"?, "remote_folder_id"?, "path": "", "ignore_rules": "<text>", "include_hidden_system"?}`; `local_path` = sync root (omitted = no local side), `remote_folder_id` = the one.gy folder at `path` (omitted = no remote side, `null` = drive root) | `{"items": [{"name","path","kind": "folder|file","size","local","remote","remote_id"? (folders),"excluded","size_skipped"}], "errors": [{"line","message"}], "more", "folder_excluded"}`; one folder of both sides, folders first, ≤2000 items; `excluded` / `size_skipped` = what the given root rules do (nested `.onegyignore` files are not read). The app's "What to sync" picker |
| `versions.list` | `{"sync_id", "path"}` (synced file) | `{"file_id", "folder_id", "content_version", "versions": [{"version_id", "content_version", "size" (plaintext), "created_at", "same_key"}]}` newest first |
| `versions.restore` | `{"sync_id", "path", "version_id"}` | file node (as `remote.list`); the sync then downloads it |
| `transfers.list` | `{"state"?: "active|queued|done|failed|paused|cancelled"}` (`active` includes paused) | `[Transfer]` |
| `transfers.pause` / `transfers.resume` | `{"id"?, "direction"?}` | `{}` |
| `transfers.cancel` | `{"id"}` | `{}` (manual transfers only; others → `validation_failed` code `not_manual`) |
| `transfers.clearCompleted` | — | `{}` |
| `issues.list` | `{"sync_id"?}` | `[Issue]` |
| `issues.resolve` | `{"id", "action", "name"?}` | `{}` |
| `issues.resolveAll` | `{"sync_id"?}` | `{"resolved"}` (Smart mode) |
| `settings.get` | — | `Settings` |
| `settings.set` | `{"patch"}` | `Settings` |
| `manual.upload` | `{"paths": [...], "remote_folder_id"}` (absolute file paths; new E2EE files) | `{"transfer_ids"}` |
| `manual.download` | `{"remote_ids": [...], "local_dir"}` (file ids; a taken name gets ` (2)`, nothing is overwritten) | `{"transfer_ids"}` |
| `activity.recent` | `{"limit": 20}` | `[{"at","sync_id","action","path"}]` |
| `files.status` | `{"paths": [...]}` (absolute, ≤1000) | `{"items": [{"path", "state"}]}`; see "File manager integration" |
| `files.webPath` | `{"path"}` (absolute, in a sync folder) | `{"path"}`: the site path of the item's one.gy folder (a file's own folder), `/files/folder/<id>` or `/files`; `not_found` when it is not on one.gy yet |
| `diagnostics.export` | `{"path"}` (absolute, `.zip`) | `{"path"}`; zip of `logs/engine.log*` and `summary.json` (counts, kinds, states, versions; no names, paths, keys or tokens) |

Notes:
- `remote.list` / `remote.createFolder` nodes use the sync-api shapes without key
  material (no wrapped keys, ciphertext names or meta); `name` is decrypted,
  `name_error: true` when it cannot be, files add `size_plain`. `folder_id: 0`
  means the drive root.
- `syncs.validate` always runs the local checks. Error codes: `invalid_type`,
  `local_invalid`, `local_missing`, `local_not_dir`, `local_not_writable`,
  `system_path`, `state_dir_overlap`, `local_overlap`, `remote_missing`,
  `remote_overlap`, `remote_read_only` (inside another device's backup; only
  a mirror may use it), `backup_nested` (a backup inside a backup),
  `full_exclusive`, `full_needs_root`, `remote_root_needs_full`, `home_dir`
  (a non-empty home folder as a `mirror` or with `initial: remote_source`:
  everything not on one.gy would be deleted; otherwise a warning), and
  `not_signed_in` / `locked` / `offline` when the one.gy side could not be
  checked. Warning codes: `home_dir`, `cloud_folder`, `fat`, `network_fs`,
  `low_space`, `quota`, `local_count_partial`. `syncs.create` / `syncs.update`
  fail with `validation_failed` carrying the same codes (plus `invalid` per
  field and `fixed_field`).
- `syncs.create` resolves symlinks in `local_path` and writes `.onegy/sync.json`.
  `syncs.remove` deletes the engine's files in `.onegy` but keeps `debris/`.
  To also delete the local folder, the app checks that `.onegy/sync.json`
  names the sync, calls `syncs.remove`, then moves the folder to the system
  trash itself.
- Backups: `syncs.create` with `type: backup` and no `remote_folder_id` uses
  `syncs.backupTarget` with `create: true`. Any backup's one.gy folder is
  marked with `POST /apiv1/sync/folders/<id>/backup` before the sync is saved
  (also when `syncs.update` changes the type to `backup`).
- Versioning (`prefer_local` / `prefer_remote` without a conflict copy, and
  the "source" initial modes replacing files) is on only while both
  `capabilities.versioning` and the account's `versioning` are true.
- `versions.restore` re-encrypts the live name when the version uses another
  file key; a file whose link wraps would need re-wrapping fails with
  `validation_failed` code `restore_on_website`.
- `syncs.preview` `items[].action`: `upload`, `download`, `conflict`,
  `delete_local`, `delete_remote`, `move_local`, `move_remote`,
  `create_local_dir`, `create_remote_dir`, `restore_remote` (brought back from
  the one.gy trash instead of created again), in execution order. A file
  conflict also counts one upload (the renamed local copy) and one download
  (with the one.gy version's bytes).
- `mass_delete` issues add `"detail": {"side": "local"|"remote", "count": n}`
  (`side` = where the items were deleted). `keep_local` / `keep_remote` mean
  that side's state wins: propagate the deletes, or bring the items back from
  the other side; `open` reviews them. Items no synced row covers count too
  (a mirror reverting local additions, a first run with `initial`
  `local_source`/`remote_source`): `side` is then the side whose state would
  win, the percentage is of the items on the side being deleted, and keeping
  them leaves them in place.
- `issues.resolve`: `retry` clears the backoff and wakes the sync; `ignore` adds
  an exact-path rule (`-pR:<path>`) to the root `.onegyignore`; `rename` renames
  the local item to `name` in the same folder; `keep_both` / `keep_remote` /
  `keep_local` (conflicts, Verify findings) run at the start of the next pass;
  `restore_remote_root` restores the trashed one.gy folder; `remove_sync`
  removes the sync like `syncs.remove` (local files kept); `open` changes
  nothing. For `mass_delete`, `delete_remote` = `keep_local` and `restore_local`
  = `keep_remote` when the items were deleted locally. An action the issue does
  not offer → `validation_failed` code `invalid_action`. `issues.resolveAll`
  keeps both versions of conflicts and retries the rest; mass-delete questions
  stay open.
- `syncs.verify` files differing items as `integrity` issues with
  `keep_remote` / `keep_local` / `ignore`.
- A file synced end-to-end encrypted that one.gy now lists as standard (or
  replaced by a standard file) is an `integrity` issue with `keep_remote` /
  `ignore`: it is neither uploaded (that would be in plain text) nor
  downloaded until the user keeps the one.gy version.
- `activity` actions: `upload`, `download`, `delete_local`, `delete_remote`,
  `move_local`, `move_remote`, `create_local_dir`, `create_remote_dir`, `conflict`
  (`path` is the original name).

## Events

Notifications from the engine: `{"jsonrpc": "2.0", "method": "event", "params": {"type": …, "data": …}}`.

| type | data |
|---|---|
| `status` | `{"state": "up_to_date|syncing|paused|offline|issues|locked|signed_out", "pending": n, "bps_up", "bps_down", "paused_up", "paused_down"}` (overall, ≤1/s; `paused_*`: that direction is paused by `transfers.pause`, so its queued transfers wait with a `note`) |
| `sync` | `Sync` (on any change; progress and `detail` ≤1/s) |
| `transfer` | `Transfer` (throttled ≤4/s per transfer; phase, note and state changes at once) |
| `issue` | `Issue` (new or resolved; resolved has `"resolved": true`) |
| `activity` | `{"at","sync_id","action","path"}` |
| `notify` | `{"title","body","kind": "conflict|issue|mass_delete|transfer|revoked|info"}` (conflicts and issues at most every 30 s per sync) |
| `verify` | `{"sync_id","done","total"}` (progress of `syncs.verify`, ≤1/s) |
| `account` | `account.status` (after any sign-in, key or app lock change) |
| `files` | `{"sync_id", "root"}`: states of items under `root` may have changed (at most once a second per sync, and once after the last change; also when the sync is removed) |

## App lock

Key states (sync-api.md "Device security", "Key tree"):

- `locked`: no keys; sync stops. After a restart the engine opens its sync
  keys with the server's unlock share (automatic, unless `pin_strict`: then
  the PIN or password is needed).
- `app_locked` (no grant) with `full_keys` false: only the folder keys of the
  sync roots and the key pool are in memory, never the master key. Sync goes
  on inside this computer's sync folders (the scope the engine sends whenever
  the syncs change while unlocked); everything else is out of reach on both
  ends: the server refuses content and writes elsewhere, the website ticket
  and `account.webUnlockKey`, and nothing outside decrypts here. Nodes
  without key-tree wraps yet wait for the next unlock (no issue).
- unlocked (`full_keys`, a grant): the master key is back (from its sealed
  copy with the PIN's master share, or the password); the engine rebuilds
  the key tree, refreshes the sync folder keys and refills the key pool.
  Locking wipes the master key again.

`lock_enabled` is on for every device that has been unlocked with the
password once by this version.

The app shows a lock screen (no site page) while `lock_enabled && app_locked`:
at start, when the OS locks the screen or sleeps, after the idle time in the
app setting `lock_after_minutes` (system idle time; on Wayland, which has
none, the time since the last input in the app's windows), when minimized or
closed to the tray with the app setting `lock_on_hide`, and from the tray. Unlocking is the PIN when
`pin_set` and before `pin_expires_at`, else the password; Windows Hello (Windows)
or a fingerprint via fprintd (Linux) when `system_unlock` is on, within the
same lifetime. Both are opt-in. Every failed unlock counts toward the same
five, whatever the kind (a wrong finger is reported by the engine; Windows
Hello keeps its own count inside Windows), and the fifth erases the PIN and
the system unlock together. The main process adds the window's `hwnd` to
`account.enableSystemUnlock` and `account.systemUnlock` on Windows so the Hello
dialog opens over the app.
The server limits it: it works only `desktop_pin_max_age_days` (admin setting,
default 14) after the last password unlock on this computer, and five wrong
PINs in a row erase it. After either, the password unlocks once (and a new PIN
can be set). The engine refreshes the grant every 5 minutes while unlocked (server TTL 15 minutes).

While `lock_enabled && app_locked` the engine refuses (`app_locked`) everything
beyond running the syncs already set up: `remote.*`, `settings.set`,
`syncs.validate|preview|browse|create|update|remove|setIgnoreRules|backupTarget|clearDebris`,
`versions.*`, `issues.resolve*` and `manual.*`. Status, lists, pause/resume,
sync now, verify, transfers, `files.*` and diagnostics keep working.

## File manager integration

Status icons and "Open on one.gy" in Nautilus, Nemo, Caja and Dolphin
(extensions installed per user by the app, `desktop/app/src/main/shell-linux.js`)
and File Explorer (`shell-win.js`).

- Extensions connect to the socket named in `<state dir>/engine.json`, check
  `ipc.hello {"nonce"}`'s `key_proof` against its `hello_key` (as the CLI
  does), then call `files.subscribe` and `files.status`. Both work without
  the IPC secret, also with `--ipc-stdio` and while the app is locked: they
  are read-only and answer only for paths the caller names. `files.subscribe`
  (no params) sends that connection `files` events and nothing else.
- `files.status` states: `synced` (as on one.gy), `syncing` (in the current
  plan, changed here since the last sync, or new while the sync is busy),
  `paused` (the same while the sync is paused), `error` (an open issue on the
  item or, for a folder, below it), `none` (outside every sync, `.onegy`,
  excluded, or not seen yet). A folder is `syncing`/`paused` while anything
  below it is planned; the sync root follows the sync's state.
- On a `files` event, re-query the items shown under `root`.
- "Open on one.gy" starts the app with `--open-item=<absolute path>` (a
  running app gets it as a second instance); the app opens `files.webPath` in
  the site view. On Windows it is a per-user context menu verb
  (`HKCU\Software\Classes\*\shell\ONEGY.Open`, `Directory\shell\ONEGY.Open`).
- Linux file managers load extensions at start: after the app installs or
  removes them, they apply once the file manager restarts (or at the next
  login). GTK ones need their Python bindings (`python3-nautilus`,
  `nemo-python`, `python3-caja`; Fedora `nautilus-python`, `nemo-python`,
  `caja-python`).
- Windows status icons (`windows_explorer_status`, NTFS only): the engine
  registers each sync root as a Cloud Files sync root of provider "ONE.GY"
  (`client/internal/cloudfiles`: WinRT `StorageProviderSyncRootManager`,
  then `CfRegisterSyncRoot`; hydration and population always full, so
  nothing is ever dehydrated) and turns synced items into full placeholders
  marked in sync after every op; File Explorer draws its own Status column.
  Turning it off or `syncs.remove` reverts the placeholders and unregisters
  the root. `localfs` reads Cloud Files placeholders (also OneDrive's) as
  files or folders by their attributes; one whose data is not all on disk
  stays special (stalled, never read).

A client subscribes by calling `engine.subscribe` (no params) on its connection.
Right after the reply the engine sends one `status` event, so a new client
never waits for the next change to show the overall state.
