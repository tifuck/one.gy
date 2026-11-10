# Engine IPC (desktop app ↔ onegy-engine), protocol 1

The contract between `desktop/engine/internal/ipc` (server) and
`desktop/app/src/main/engine.js` (client). Change both sides together.

## Transport

- Linux: Unix socket `$XDG_RUNTIME_DIR/onegy/engine.sock` (dir 0700, socket
  0600). Without `XDG_RUNTIME_DIR`: `<state dir>/run/engine.sock`.
- Windows: named pipe `\\.\pipe\onegy-engine-<USERNAME>`, DACL = current user only.
- Framing: one JSON object per line (`\n`-terminated, UTF-8). JSON-RPC 2.0.
- The engine also accepts `--socket <path>` (tests, multiple instances) and
  writes `<state dir>/engine.json` `{"pid", "socket", "version"}` once listening.
- State dir: Windows `%APPDATA%\ONE.GY`, Linux `$XDG_DATA_HOME/onegy`
  (default `~/.local/share/onegy`). Overridable with `--state-dir`.
- IPC secret: the app starts the engine with `--ipc-secret-stdin` and writes a
  random secret (≥ 32 chars) plus `\n` to its stdin. Every connection must then
  call `ipc.hello {"secret"}` first; until it does, only `ipc.hello`,
  `engine.info` and `engine.shutdown` answer, everything else is `forbidden`.
  A wrong secret is `forbidden`. An engine left running by a crashed app has
  another secret: the app asks it to shut down and starts its own. Without the
  flag (tests, `onegyctl`, the dev bridge before 0.4) `ipc.hello` always succeeds.

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
 "stats": {"pending_up": 3, "pending_down": 0, "bytes_left": 1048576,
           "issues": 1, "last_synced_at": "2026-11-08T14:32:00Z"},
 "created_at": "…"}
```
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
 "error": null, "started_at": "…", "finished_at": null, "manual": false}
```
`state`: `queued` | `active` | `paused` | `done` | `failed` | `cancelled`.
`cancelled` also covers sync transfers dropped because the plan changed or the
sync was paused (they are re-planned); `error` is set only for `failed`.

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
 "require_password_on_start": false, "web_unlock": true,
 "mass_delete_count": 50, "mass_delete_percent": 20,
 "defaults": {"type": "two_way", "conflict_policy": "keep_both",
              "issue_mode": "smart", "debris_days": 30, "thumbnails": true}}
```

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
| `account.status` | — | `{"signed_in", "locked", "full_keys", "app_locked", "lock_enabled", "pin_set", "pin_expires_at", "pin_strict", "pin_attempts_left", "signed_requests", "hardware_key", "server", "username", "user_id", "device_id", "device_name", "storage_used", "storage_limit", "versioning"}` (see "App lock"; `versioning`: one.gy keeps previous versions on replace, from `GET /apiv1/me`) |
| `account.authorize` | `{"server", "username", "password", "totp_code"?, "device_name"}` | `account.status`; the app is left unlocked so a PIN can be chosen |
| `account.unlock` | `{"password", "new_pin"?, "pin_strict"?}` | `account.status`; opens the password-sealed keys (works offline), then unlocks the app online; `new_pin` (opt-in) also sets the PIN, validated before anything changes |
| `account.appUnlock` | `{"pin"}` | `account.status`; errors `invalid_pin` (re-read `pin_attempts_left`), `pin_locked`, `pin_expired`, `pin_not_set` (use `account.unlock`) |
| `account.appLock` | — | `account.status`; drops the grant (sync goes on inside the scope) |
| `account.setPin` | `{"pin", "strict"}` | `account.status`; app unlocked; 6 to 64 characters |
| `account.removePin` | — | `account.status`; app unlocked; the lock then asks for the password |
| `account.signOut` | `{"revoke": true}` | `{}`; pauses syncs, wipes keys, keeps files |
| `account.webSession` | — | `{"ticket", "url"}` (main process only): load `url` with header `X-Onegy-Desktop-Ticket: <ticket>` to sign the site view in; `app_locked` while locked |
| `account.webUnlockKey` | — | `{"master_key_b64"}` or error `locked`; only when `web_unlock` and the app is unlocked (`app_locked` otherwise) |
| `remote.list` | `{"folder_id": null}` | `{"folder": node|null, "folders": [...], "files": [...]}`, names decrypted, + `size_plain` |
| `remote.createFolder` | `{"parent_id", "name", "e2ee": true}` | folder node |
| `syncs.list` | — | `[Sync]` |
| `syncs.validate` | `{"local_path", "remote_folder_id"?, "type"}`; `remote_folder_id` omitted (not `null`, which is the drive root) = local checks only, no `remote` in the result | `{"ok", "errors": [{"code","message"}], "warnings": [...], "fs": {"kind","case_sensitive","free_bytes"}, "local": {"files","bytes"}, "remote": {"files","bytes"}}` |
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
  `full_exclusive`, `full_needs_root`, `remote_root_needs_full`, and
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
  the other side; `open` reviews them.
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
- `activity` actions: `upload`, `download`, `delete_local`, `delete_remote`,
  `move_local`, `move_remote`, `create_local_dir`, `create_remote_dir`, `conflict`
  (`path` is the original name).

## Events

Notifications from the engine: `{"jsonrpc": "2.0", "method": "event", "params": {"type": …, "data": …}}`.

| type | data |
|---|---|
| `status` | `{"state": "up_to_date|syncing|paused|offline|issues|locked|signed_out", "pending": n, "bps_up", "bps_down"}` (overall, ≤1/s) |
| `sync` | `Sync` (on any change) |
| `transfer` | `Transfer` (throttled ≤4/s per transfer) |
| `issue` | `Issue` (new or resolved; resolved has `"resolved": true`) |
| `activity` | `{"at","sync_id","action","path"}` |
| `notify` | `{"title","body","kind": "conflict|issue|mass_delete|transfer|revoked|info"}` (conflicts and issues at most every 30 s per sync) |
| `verify` | `{"sync_id","done","total"}` (progress of `syncs.verify`, ≤1/s) |
| `account` | `account.status` (after any sign-in, key or app lock change) |

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
app setting `lock_after_minutes`, and from the tray. Unlocking is the PIN when
`pin_set` and before `pin_expires_at`, else the password. The PIN is opt-in.
The server limits it: it works only `desktop_pin_max_age_days` (admin setting,
default 14) after the last password unlock on this computer, and five wrong
PINs in a row erase it. After either, the password unlocks once (and a new PIN
can be set). The engine refreshes the grant every 5 minutes while unlocked (server TTL 15 minutes).

A client subscribes by calling `engine.subscribe` (no params) on its connection.
Right after the reply the engine sends one `status` event, so a new client
never waits for the next change to show the overall state.
