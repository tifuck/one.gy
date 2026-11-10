# Sync API (server ↔ desktop engine), protocol 1

The contract between `src/app/045_sync_feed.py`, `375_apiv1_sync.py`,
`376_apiv1_sync_uploads.py` (server) and `desktop/engine/internal/api` (client).
Change both sides together and bump `protocol` on breaking changes.
Design rationale: `docs/desktop-client-plan.md` (DEV-only doc), sections 7–8.

## Conventions

- Base: `https://<server>`. All bodies are JSON (`Content-Type: application/json`)
  unless stated otherwise. All timestamps are ISO-8601 UTC (`2026-11-08T14:32:00Z`).
- Auth: `Authorization: Bearer dev_<token>` (a **device token**). Routes marked
  *(device)* require it. Existing `/apiv1/*` routes listed in "Reused routes"
  accept either an API key or a device token.
- Client header: `X-Onegy-Client: onegy-desktop/<version> (<windows|linux>; <arch>)`.
- Errors: `{"error": "<human text>", "code": "<code>"}` plus extra fields as noted.

| HTTP | code | Meaning |
|---|---|---|
| 400 | `bad_request` | Malformed or missing field (`field` names it). |
| 401 | `invalid_token` | Unknown token. |
| 401 | `device_revoked` | Token belonged to a revoked device. Client wipes its keys. |
| 401 | `invalid_credentials` / `totp_required` / `invalid_totp` | Device authorization only. |
| 403 | `sync_disabled` | Admin setting `allow_desktop_sync` is off. |
| 403 | `captcha_required` | Too many failed sign-ins; user must sign in on the website first. |
| 403 | `read_only` | Target is inside a backup folder owned by another device (also returned by website and API-key routes). |
| 404 | `not_found` | Not owned by this user, or does not exist. |
| 409 | `conflict` | Version mismatch on replace (`current` = node), id already taken, or a plaintext folder name already used by a sibling. |
| 409 | `device_limit` | `max_devices_per_user` reached. |
| 410 | `cursor_expired` | `min_cursor` tells the oldest cursor still served. |
| 412 | `precondition_failed` | `if_seq` / `If-Match` mismatch; `current` = node. |
| 413 | `quota_exceeded` | Storage limit. |
| 416 | `bad_request` | `Range` not satisfiable (`Content-Range: bytes */<size>`). |
| 426 | `client_too_old` | `min_client_version` given. |
| 429 | `rate_limited` | Honour `Retry-After`. |
| 500 | `integrity_error` | Stored payload failed a size/checksum check; retry later. |
| 503 | `busy` | Honour `Retry-After`. |

## Node shapes

Every file or folder the user owns (registered, non-temp) has a `seq`: the
user-wide change sequence of its last sync-relevant change.

```json
{"type": "folder", "id": 12, "parent_id": 3, "seq": 881, "is_trashed": false,
 "is_e2e": true, "name": "<placeholder or plaintext>",
 "encrypted_name": "b64", "name_nonce": "b64",
 "encrypted_name_key": "b64", "name_key_nonce": "b64",
 "is_backup": false, "backup_device_id": null,
 "updated_at": "2026-11-08T14:32:00Z", "folder_link_share_token": null}
```

```json
{"type": "file", "id": "uuid", "folder_id": 12, "seq": 882, "is_trashed": false,
 "is_e2e": true, "name": "<placeholder or plaintext>",
 "encrypted_name": "b64", "name_nonce": "b64",
 "encrypted_file_key": "b64", "file_key_nonce": "b64", "stored_extension": ".pdf",
 "size": 1234, "disk_size": 1234, "payload_checksum": "sha256 hex",
 "content_version": 3, "encrypted_meta": "b64|null", "meta_nonce": "b64|null",
 "uploaded_at": "…", "trashed_by_device_id": null,
 "folder_link_share_token": "uuid|null", "needs_folder_link_key": false}
```

- `parent_id` / `folder_id` `null` = drive root.
- For E2EE files `size` is the **ciphertext** size; plaintext size is
  `size - 17 - 20 * ceil(plain/64MiB)` or, simpler, `plain_size` in the meta.
- Standard (non-E2EE) nodes have `is_e2e: false`, a real `name`, and null crypto fields.
- `folder_link_share_token` / `needs_folder_link_key`: see "Link-shared folders".

### Encrypted metadata (`encrypted_meta`)

Plaintext (UTF-8 JSON, keys in this order):
`{"v":1,"file_id":"uuid","content_version":3,"plain_size":123,"plain_sha256":"hex","mtime_ns":1731076320000000000,"mode":420}`
Encrypted with AES-256-GCM under the **file key**, random 12-byte nonce, no AAD,
base64 (standard alphabet). Opaque to the server. Clients must reject a node
whose decrypted meta has a different `file_id` or a lower `content_version`
than the node. A website edit (`save-content`) bumps `content_version`, may
rotate the file key (new `encrypted_file_key`) and clears `encrypted_meta`; the
client backfills it with `/meta` after downloading and verifying.

## Devices

### `POST /apiv1/devices/pre-login` (no auth)
`{"username": "alice"}` → `{"split_key_version": 1, "auth_token_salt": "b64"}`. Same
opaque response and limits as `/auth/pre-login`, but without a CSRF session.

### `POST /apiv1/devices/authorize` (no auth)

```json
{"username": "alice", "auth_token": "b64", "totp_code": "123456",
 "device_name": "LAPTOP", "platform": "windows", "client_version": "0.1.0"}
```
`auth_token` = split-key auth token (see `static/crypto.js`
`deriveAuthAndWrappingKeys`, salt from `POST /apiv1/devices/pre-login`).
Same brute-force lockout, rate limit and captcha threshold as `/login`.
`platform` is `windows` or `linux`; `device_name` ≤ 80 chars; `totp_code` only
when 2FA is on (missing → `totp_required`). Lockout → `429` with `Retry-After`.
→ `201 {"device_id": "uuid", "device_token": "dev_…", "user": {"id": 1, "username": "alice"}}`.
The token is returned once; the server stores only `SHA-256(token)`.

### `GET /apiv1/devices/keys` (device)
Same body as session `GET /api/keys`.

### `GET /apiv1/me` (device)
`{"user_id", "username", "storage_used", "storage_limit", "has_e2ee_keys",
"versioning": true, "device": {"id", "name", "platform", "created_at"}}` (bytes).
`storage_used` includes previous file versions. `versioning` = this account keeps
versions on replace (server enabled and the user's *Keep previous versions* on).

### `PATCH /apiv1/devices/self` (device)
`{"name"?: str ≤80, "client_version"?: str}` → device object.

### `DELETE /apiv1/devices/self` (device) → `204`. Token stops working.

## Device security

Server: `src/app/378_apiv1_device_security.py` (routes) and
`110_auth_decorators_download_limits.py` (request checks). Engine:
`internal/account`, `internal/devkey`.

**Signed requests.** `authorize` takes an optional `pop_public_key` (base64 DER
SubjectPublicKeyInfo, ECDSA P-256). Devices authorized before this enroll one
once with `POST /apiv1/devices/self/pop-key {"public_key"}` (`409` when one
exists). From then on every device-token request must carry
`X-Onegy-Pop-Ts: <unix seconds>` (±300 s) and `X-Onegy-Pop-Sig: <base64 DER
ECDSA/SHA-256>` over `"<ts>\n<METHOD>\n<path>"` + `"?<raw query>"` when there
is one (decoded path, raw query); else `401 invalid_signature` (not a
revocation). The engine keeps the key in the TPM on Windows when it can (it
self-checks a signature first), else as a software key in the OS key store.
A token copied off the computer is then useless.

**At rest.** Nothing on the computer opens on its own. `local_key` is in the OS
key store; two 32-byte shares live only on the server:
- the scope set (folder keys of the sync roots, see "Key tree", and the key
  pool's key) under `HKDF-SHA256(unlock_share ‖ local_key, "onegy-device-scope-v1")`;
  `unlock_share` comes with `{}` (not with `pin_strict`), so syncing resumes
  after a restart without the master key;
- the master key under `HKDF-SHA256(master_share ‖ local_key, "onegy-device-master-v1")`;
  `master_share` comes only with the PIN or the password.

A removed device never gets a share again, so its disk copies are dead.

**App lock and grants.** A grant (`X-Onegy-Grant: dgr_…`, 15 min TTL) means the
app is unlocked. A device with `lock_enabled` and no valid grant may read
metadata (feed, tree, listings, `/me`, keys) but gets `403 locked` for file
content (`…/content`) and for any write whose source or target folder is
outside its scope (drive root included unless `root`). The first password
unlock turns `lock_enabled` on for good.

| Route (device) | Body | Result |
|---|---|---|
| `POST /apiv1/devices/self/unlock` | `{}` | `{"unlock_share", …security}`; `401 pin_required` when `pin_strict` |
| same | `{"pin_proof"}` | `+ "master_share", "grant", "grant_expires_at"`; `401 invalid_pin` (`attempts_left`), `409 pin_locked` (5 wrong in a row: PIN erased), `409 pin_expired`, `409 pin_not_set` |
| same | `{"auth_token"}` (password, split-key) | `+ "grant"`; resets the PIN's lifetime and failures; login lockout applies |
| `POST /apiv1/devices/self/grant` | — | grant: slide its expiry → `{"grant_expires_at"}` |
| `DELETE /apiv1/devices/self/grant` | — | `204`; the grant and its website sessions end |
| `PUT /apiv1/devices/self/pin` | `{"pin_proof", "strict"}` | grant; `409 password_required` before any password unlock |
| `DELETE /apiv1/devices/self/pin` | — | grant; back to password unlock |
| `PUT /apiv1/devices/self/scope` | `{"root": bool, "folders": [ids ≤500]}` | grant; owned folders only |
| `POST /apiv1/devices/self/web-session` | — | grant → `{"ticket": "wst_…", "expires_in": 60}` |

security = `{"lock_enabled", "pin_set", "pin_expires_at", "pin_strict",
"pin_attempts_left", "signed_requests"}` (also in `/apiv1/me` `device`).
`pin_proof` = base64 `HMAC-SHA256(pin_key, "onegy-pin-proof-v1")` with
`pin_key = PBKDF2-SHA256(pin, "onegy-pin-v1:<device id>", 200000, 32)`; the
server keeps `SHA-256(pin_proof)`. The PIN works until the last password
unlock + `desktop_pin_max_age_days` (admin setting, default 14); a PIN unlock
never extends that.

**Website sign-in.** `GET /desktop/session?next=<path>` with header
`X-Onegy-Desktop-Ticket: <ticket>` (one use, 60 s, needs a live grant) signs
the browser in and redirects to `next` (same-site path) or `/files`. The
session carries `device_id` and ends when the device is removed or its grant
ends (app locked). A header, so a link or cross-site form cannot log anyone
in. `GET /desktop/whoami` (website session) → `{"user_id", "device_id"}`.

## Key tree

Lets a locked app keep syncing its folders without the master key. Written
and read only by ONE.GY Desktop; the website and the CLI keep using the
master-key wraps, which stay the source of truth, so the tree is an index any
unlocked engine can rebuild.

- Every folder has a random 32-byte **folder key**, stored as `tree_key_wrap` /
  `tree_key_nonce` (AES-256-GCM, like every key wrap) under the folder key of
  `tree_key_parent_id` (`0` = the **root key** = `HKDF-SHA256(master key,
  info "onegy-tree-root-v1")`). An E2EE folder's name key is also wrapped
  under its own folder key (`tree_name_key_wrap` / `_nonce`); an E2EE file's
  key under the folder key of `tree_key_folder_id` (`tree_file_key_wrap` /
  `_nonce`). All on the folder and file nodes (`null` when absent).
- A wrap names the folder it is wrapped under, so it stays readable after a
  move until a client rewraps it. The server drops `tree_file_key_wrap` when a
  file's key changes and `tree_name_key_wrap` when a folder's name key
  changes, unless the same change writes a new one; folder keys never change.
- A locked engine holds only the folder keys of its sync roots (the root key
  for a whole-drive sync) and derives everything below them. Nodes it cannot
  reach (no or stale wrap: e.g. files the website just added) wait for the
  next unlock, quietly. New files and folders take keys from a pool of
  pre-made keys (made while unlocked, already wrapped with the master key, so
  the website reads them as usual) and get their tree wraps at once. Folder
  link keys need the master key: a locked engine leaves them to the website
  (`needs_folder_link_key`).

### `POST /apiv1/sync/tree-keys` (device)
```json
{"folders": [{"id": 12, "tree_key_wrap": "b64", "tree_key_nonce": "b64", "tree_key_parent_id": 0,
              "if_tree_key_wrap": null, "tree_name_key_wrap": "b64", "tree_name_key_nonce": "b64"}],
 "files": [{"id": "uuid", "tree_file_key_wrap": "b64", "tree_file_key_nonce": "b64", "tree_key_folder_id": 12}]}
```
→ `{"folders": [node], "files": [node], "conflicts": [folder ids]}`, ≤ 500 items.
A folder key is compare-and-set: `if_tree_key_wrap` is the wrap the client
read (`null` = none); on a mismatch the folder is left alone, listed in
`conflicts` and returned as it is, so every device wraps children under the
same key. Omit `tree_key_wrap` to set only the name-key wrap. Wraps are 48
bytes, nonces 12 (`400`). Without a grant only items inside the scope
(`403 locked`). Writes bump `seq`. Key material only: backups do not restrict it.

## Change feed

### `GET /apiv1/sync/capabilities` (device)
```json
{"protocol": 1, "chunk_size": 67108864, "small_upload_max": 8388608,
 "max_upload": 10737418240, "max_parallel_transfers": 2, "poll_min_seconds": 5,
 "versioning": true, "backups": true, "min_client_version": "0.1.0"}
```
`versioning` is `false` when the admin set `file_version_retention_count` to 0.

### `GET /apiv1/sync/cursor` (device)
`{"seq": 882}` with `ETag: "seq-882"`. `If-None-Match: "seq-882"` → `304`.

### `GET /apiv1/sync/changes?cursor=<seq>&limit=<1..1000, default 500>` (device)
All of the user's folder and file nodes with `seq > cursor` (trashed ones
included, `is_trashed: true`), plus tombstones for hard deletes, ordered by `seq`.
```json
{"changes": [<node>, …],
 "tombstones": [{"type": "file", "id": "uuid", "seq": 883}],
 "next_cursor": 883, "has_more": false}
```
`next_cursor` = highest seq returned (or `cursor` if none). A cursor older than
the oldest retained tombstone, or newer than the server's current seq (server
restored or wiped) → `410 cursor_expired`. All items of one seq are always in
the same page; one seq larger than `limit` (e.g. a big folder trash) is sent
whole. Rows that predate the feed have `seq: 0` and only appear in `/tree`.

Ordering guarantee: seqs are allocated under a per-user row lock held to
commit, so a seq never becomes visible after a higher one.

### `GET /apiv1/sync/tree?root=<folder id or 0>&page_token=<opaque>&limit=<≤2000>` (device)
Non-trashed subtree under `root` (0 = drive root), folders first, paginated.
```json
{"as_of_seq": 880, "root": <folder node or null>, "folders": [...], "files": [...],
 "next_page_token": "…|null"}
```
`as_of_seq` is read before the first page; clients apply
`/changes?cursor=as_of_seq` after the last page.

## Content

### `GET /apiv1/sync/files/<id>/content` (device)
- E2EE: the raw container bytes. Supports a single `Range` (`206`), returns
  `ETag: "<payload_checksum>"`, honours `If-Match` (quoted or bare checksum; → `412`
  with `current`).
- Standard: decrypted plaintext, full body only.
- Never touches `download_count` / `max_downloads`.

## Mutations (device)

All return the updated node. `if_seq` optional; when given and the node's
current `seq` differs → `412` with `current`.

| Route | Body |
|---|---|
| `POST /apiv1/sync/files/<id>/move` | `{"folder_id": 12 or null, "if_seq": 882}` + optional folder-link wrap (E2EE files; see "Link-shared folders") |
| `POST /apiv1/sync/files/<id>/rename` | E2EE `{"encrypted_name", "name_nonce", "stored_extension", "if_seq"}`; standard `{"name", "if_seq"}` |
| `POST /apiv1/sync/folders/<id>/move` | `{"parent_id": 3 or null, "if_seq"}` (no cycles → `400`) |
| `POST /apiv1/sync/folders/<id>/rename` | E2EE `{"encrypted_name", "name_nonce", "if_seq"}` (name key unchanged); standard `{"name", "if_seq"}` |
| `POST /apiv1/sync/files/<id>/trash` | `{"if_seq"}` → soft delete, `trashed_by_device_id` set |
| `POST /apiv1/sync/folders/<id>/trash` | `{"if_seq"}` → soft delete of the subtree |
| `POST /apiv1/sync/files/<id>/restore` | `{}` (not in the trash → `404`) |
| `POST /apiv1/sync/folders/<id>/restore` | `{}`; brings back what was trashed with the folder (not in the trash → `404`) |
| `POST /apiv1/sync/files/<id>/meta` | `{"encrypted_meta", "meta_nonce", "if_content_version"}` (required; mismatch → `412`; E2EE files only) |
| `POST /apiv1/sync/files/<id>/folder-link-key` | folder-link wrap (all three fields; E2EE files only) → node; does not change `seq` |

Folder create: reuse `POST /apiv1/folders` (accepts device tokens; response
gains `seq`). Use `client_dedupe_token` for idempotency.

## Uploads (device)

The client may propose the new file's id (`file_id`, UUID v4) so the encrypted
meta can include it; a taken id → `409 conflict`. Without it the server
generates one. `upload_id` (≤64 chars) is the idempotency key, unique per user:
repeating a committed upload returns `200 {"existing": true, "node": …}`
(also for a replace: the replaced file then carries that `upload_id`).
`encrypted_meta` + `meta_nonce` are optional but go together. Writes into a
backup folder of another device → `403 read_only`.

### `POST /apiv1/sync/files` (multipart, container ≤ `small_upload_max`)
Fields: `upload_id`, `file_id`?, `folder_id` (empty = root), `mode`
(`e2ee`|`standard`), `file` (part).
E2EE: `encrypted_file_key`, `file_key_nonce`, `encrypted_name`, `name_nonce`,
`stored_extension`, `encrypted_meta`, `meta_nonce`, optional
`encrypted_thumbnail` (part) + `thumbnail_nonce`.
Standard: `name`.
E2EE, optional: the folder-link wrap (see "Link-shared folders").
Replace instead of create: `replace_file_id` + `base_content_version`; for E2EE
omit the key and name fields: the container must be encrypted with the
**existing** file key (link shares stay valid); sending them (or a
folder-link wrap: the wraps stay too) → `400`. Replace
never changes the mode (`400`). Version mismatch → `409` with `current`.
A `file` part larger than `small_upload_max` → `400` (use a session).
→ `201 <node>` (create) or `200 <node>` (replace).

### Upload sessions (larger files)
- `POST /apiv1/sync/uploads` JSON: `upload_id`, `file_id`?, `folder_id`, `mode`,
  `chunk_count`, `cipher_size`, `cipher_sha256` (of the whole container, or of
  the plaintext in standard mode), E2EE: `header_b64` (17 bytes) + the E2EE
  fields above; standard: `name`, `plain_size` (`cipher_size` may be omitted or
  must equal it); replace: `replace_file_id`, `base_content_version`.
  `chunk_count` ≤ payload size / 1 MiB + 1 (non-final parts carry ≥ 1 MiB);
  size ≤ `max_upload` (`400`). Quota is checked advisorily here, counting this
  user's other open sessions as in-flight bytes (`413`).
  → `201 {"session_id", "file_id", "parts_received": [], "expires_at"}`.
  Same `upload_id` again → `200` with the same session body (or
  `200 {"existing": true, "node"}` once committed).
- `PUT /apiv1/sync/uploads/<sid>/parts/<i>` body = raw bytes; header
  `X-Content-SHA256: <hex>`. E2EE: one framed chunk (`len BE32 ‖ ct ‖ tag`,
  ≤ 64 MiB + 20, length prefix must match). Standard: plaintext slice ≤
  `chunk_size`. `Content-Length` required. Body not matching the header hash →
  `400`. → `200` with the session body (`expires_at` slides). Same index + same
  hash again → `200`; different hash → `409`.
- `GET /apiv1/sync/uploads/<sid>` → `{"session_id", "file_id", "parts_received": [0,1], "expires_at"}`
  (all session bodies have this shape). Unknown, expired or aborted → `404`.
- `POST /apiv1/sync/uploads/<sid>/complete` JSON (optional
  `encrypted_thumbnail_b64`, `thumbnail_nonce`) → assembles, validates the
  container, checks `cipher_sha256`, checks quota under the quota lock, commits.
  → `201`/`200 <node>`. Missing parts → `400` with `missing: [i, …]`. A size /
  `cipher_sha256` mismatch or an invalid container → `400` and the session is
  aborted (nothing committed; start over). Completing an already committed
  session → `200 {"existing": true, "node"}`.
- `DELETE /apiv1/sync/uploads/<sid>` → `204`.
- Sessions idle longer than `sync_upload_session_ttl` (default 86400 s) are deleted.

## Link-shared folders

A folder shared by link (website) lets visitors open the E2EE files below it
only when each file key is also wrapped with the folder's link key. The link
key is `deriveLinkSecret(master key, "folder", share_token)` (`static/crypto.js`,
Go `e2ee.DeriveLinkSecret`: HKDF-SHA256, salt `onegy-link-secret-v1`, info
`folder:<share_token>`), the wrap is AES-256-GCM of the raw file key under it
with a random 12-byte nonce (`wrapFileKeyForLink`).

- `folder_link_share_token` on a folder node: the share token governing files
  placed directly in that folder (nearest link-shared ancestor or itself; a
  browsable shared ancestor further up wins, as on the website), else `null`.
  On a file node: the token governing its folder.
- `needs_folder_link_key: true`: an E2EE file under a link-shared folder
  without a wrap. Link visitors do not see it until the wrap is stored.
- Both are computed when the node is sent: sharing, unsharing or re-sharing an
  ancestor does not change `seq` (the website re-wraps the files itself then).
- A folder-link wrap in a request is `folder_link_encrypted_file_key` +
  `folder_link_file_key_nonce` (base64; 48 + 12 bytes) + the
  `folder_link_share_token` it was derived from, all three or none (`400`).
  Accepted by `POST /apiv1/sync/files` and `POST /apiv1/sync/uploads` (create
  only), file move, and `POST /apiv1/sync/files/<id>/folder-link-key`.
- Uploads and moves store the wrap only when its token is the one governing
  the target folder; otherwise it is ignored and the node says
  `needs_folder_link_key`. The backfill route answers `409 conflict` with
  `current` instead. A move into a differently shared folder drops the old
  wrap (as on the website).
- Clients: wrap on upload/move when the target's token is known, else answer
  a node with `needs_folder_link_key` through the backfill route. After moving
  a folder into a link-shared tree, list it with `/tree?root=<id>` and
  backfill its flagged files (the move answer is the folder node only).

## Backups

A backup folder (`is_backup: true`) is writable only by the device in
`backup_device_id`. Every other writer (other devices, the website, API keys) gets
`403 read_only` for: uploads and replaces into it, folder create inside it,
rename / move (into or out of) / trash of it or anything inside it, `/meta`,
trashing or deleting a folder that contains it, and setting an expiry on it.
Restores never land inside it: a file or folder whose original parent is a
read-only backup comes back at the drive root instead. Reads are unaffected.

Setup (client side, all idempotent): create `Backups` at the drive root and
`Backups/<device name>/<name>` with `POST /apiv1/folders` (E2EE name fields +
`client_dedupe_token`), then mark the last one. The server does not enforce the
layout; any folder the user picks can be a backup.

### `POST /apiv1/sync/folders/<id>/backup` (device)
`{"enabled": true|false, "if_seq"?}` → folder node.
- `true`: marks the folder as a backup of the calling device. Already a backup of
  this device → no-op. A backup of another device → `403 read_only`. Backups never
  nest: an ancestor or descendant that is already a backup → `409 conflict`.
- `false`: the calling device's backup becomes a normal folder (no-op when it is
  not a backup). Another device's backup → `403 read_only`.

The website stops a backup in *Devices* (`/account/devices`): keep it as a normal
folder or move it to the trash. Backups of removed devices stay read-only until
then.

## Versions

When the owner keeps versions, every content replace (sync replace, website
edit, version restore) keeps the previous content as a version. Versions are
never nodes: they are not in `/tree`, `/changes`, listings, search or the trash.
The live node's `content_version` / `seq` change as for any replace. Versions
count toward quota (a version is skipped, not the replace, when it would not fit).
The server deletes versions beyond `file_version_retention_count` per file
(default 10), older than `file_version_retention_days` (default 90), and those
of hard-deleted files.

### `GET /apiv1/sync/files/<id>/versions` (device)
Live (non-trashed) files only. Newest first.
```json
{"file_id": "uuid", "content_version": 4,
 "versions": [{"version_id": "uuid", "content_version": 3, "size": 1234, "disk_size": 1234,
               "payload_checksum": "hex", "encrypted_meta": "b64|null", "meta_nonce": "b64|null",
               "encrypted_file_key": "b64|null", "file_key_nonce": "b64|null",
               "same_key": true, "created_at": "…"}]}
```
- `content_version` / `encrypted_meta` are the ones the content had when current.
- `encrypted_file_key` / `file_key_nonce` (E2EE): the key this version is encrypted
  under. Sync replaces keep the key (`same_key: true`); a website edit rotates it,
  so older versions may need their own key (`same_key: false`).
- `created_at`: when this content was replaced (became a version).

### `GET /apiv1/sync/files/<id>/versions/<vid>/content` (device)
Same semantics as `/content` (Range, `ETag` = version `payload_checksum`,
`If-Match` → `412` with `current` = the version object). Never counts downloads.

### `POST /apiv1/sync/files/<id>/versions/<vid>/restore` (device)
`{"base_content_version"?: int, "encrypted_meta"?, "meta_nonce"?,
  "encrypted_name"?, "name_nonce"?, "link_encrypted_file_key"?, "link_file_key_nonce"?,
  "folder_link_encrypted_file_key"?, "folder_link_file_key_nonce"?}` → `200 <node>`.
A replace with the version's payload: `content_version + 1`, the current content
becomes a version (when kept), the restored version stays. `base_content_version`
mismatch → `409` with `current`. `encrypted_meta` + `meta_nonce` (for the new
`content_version`) are optional; without them the node's meta is null.
When `same_key` is false the live file takes the version's key, so the live
name (`encrypted_name` + `name_nonce`) and, when the file has them, its link
wraps must be sent re-encrypted / re-wrapped under the version's key; missing →
`400` with `key_changed: true` and `field`. Inside another device's backup → `403`.

### `DELETE /apiv1/sync/files/<id>/versions/<vid>` (device) → `204`.

The website has the same operations with session auth: `GET /file/<id>/versions`,
`GET /file/<id>/versions/<vid>/content` (standard files download as plaintext
attachments), `POST /file/<id>/versions/<vid>/restore` (JSON body as above),
`POST /file/<id>/versions/<vid>/delete`.

## Known limitations (protocol 1)

- `upload_id` must be unique per user forever: the engine uses a random
  `op-<32 hex>` per upload op (an op counter would collide across devices and
  after a state DB rebuild, and a repeated id answers with the earlier file).

## Reused routes

`GET /apiv1/files[/<folder_id>]`, `POST /apiv1/folders`,
`GET /apiv1/trash` accept device tokens through `api_or_device_auth`.
