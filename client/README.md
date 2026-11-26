# onegy client

One Go module, one binary: `onegy`. The same build is the command-line tool
(served by the website at `/static/cli/`, installed with `/cli.sh`) and the
sync engine ONE.GY Desktop runs as `onegy daemon`. The desktop installers also
put the bundled copy on PATH (deb/rpm `/usr/bin/onegy`, Windows user PATH; not
the AppImage). `VERSION` is the single version of the binary and the desktop app.

Contracts: `../desktop/docs/engine-ipc.md` (app ↔ engine) and
`../desktop/docs/sync-api.md` (engine ↔ server). `e2ee/` is the one Go
implementation of the file format and key wrapping; it stays byte-compatible
with `../static/crypto.js`, the only other implementation (`go test ./e2ee/`
cross-checks against it through `../tests/crypto_helper.js`).

```bash
go test ./... && go build ./cmd/onegy
bash build.sh                                   # signed CLI builds for /static/cli/ (DOMAIN, CLI_SIGNING_KEY_FILE from ../.env)
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./cmd/onegy   # release cross-compile
go build -tags devtls -o bin/onegy ./cmd/onegy  # allows `daemon --insecure-tls` and `--insecure` (local DEV server only)
./bin/onegy daemon --state-dir /tmp/e --socket /tmp/e.sock      # run the engine by hand
./bin/onegy ipc --state-dir /tmp/e call engine.info             # talk to a running engine
```

## Commands

- `onegy upload <file>` / `onegy download <url>`: anonymous E2EE temp upload and
  share-link download. These self-update from `/cli/version` unless the build is
  `-X main.bundled=1` (the desktop app's copy updates with the app), and only
  to a strictly newer `version` than their own (never a downgrade), and only
  from the same origin (no cross-host redirects).
  Updates must be signed: `build.sh` embeds the Ed25519 public key of
  `CLI_SIGNING_KEY_FILE` (default `~/.config/onegy/cli-signing.key`, generated
  on the first build, never inside the repo) as `-X main.updatePublicKey` and
  adds a `signature` to each manifest entry over
  `onegy-cli-update-v1\n<domain>\n<version>\n<platform>\n<sha256>\n`
  (`release_sign.go`; older clients ignore the field). A build without the key
  (`go build`, the desktop app) never self-updates. `download` refuses the
  legacy v1 file format (no chunk AAD, so truncation is undetectable) unless
  given `--allow-legacy-v1`.
- `onegy daemon [--state-dir --socket --log-level --ipc-stdio --secrets-file --insecure-tls]`:
  the sync engine (flags, single-instance lock, log file, IPC listener). Not on
  macOS yet (`localfs`/`watch` have no darwin port), so macOS builds ship the
  file commands only.
- `onegy login | unlock | lock | logout | status | sync … | issues …`
  (`cmd_sync.go`): folder sync without the desktop app. Thin front ends to the
  running engine's IPC methods, the same ones the desktop app calls; `onegy`
  without arguments prints them all.
- `onegy ipc call <method> [json]` / `onegy ipc watch`: any method of the
  engine's JSON-RPC interface (settings, versions, transfers, ignore rules…).
  Clients find the engine through `<state dir>/engine.json` and check, before
  sending anything, that it proves the key written there (`ipc.DialEngine`).

## Headless (a server without a desktop)

The engine is the same as in ONE.GY Desktop. Two things differ on a server:
there is no OS key store (Secret Service needs a desktop session), and nothing
starts the engine. `--secrets-file` keeps the device token, the local key and
the request-signing key in `<state dir>/secrets.json` (0600) so syncing
resumes after a reboot without the password. The master key never goes there:
it stays sealed under a share only the server hands out with the password.
Without the flag the engine starts locked after every restart until `onegy unlock`.

```bash
curl -fsSL https://one.gy/cli.sh | bash -s -- version     # installs ~/.onegy/bin/onegy
sudo tee /etc/systemd/system/onegy.service <<EOF
[Unit]
Description=ONE.GY sync engine
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
ExecStart=$HOME/.onegy/bin/onegy daemon --secrets-file
Restart=on-failure
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now onegy
~/.onegy/bin/onegy login
~/.onegy/bin/onegy sync add ~/data /Servers/web1     # or --type backup|mirror|archive
~/.onegy/bin/onegy lock                              # optional, see below
~/.onegy/bin/onegy status
```

- Locked, the engine keeps syncing the sync folders without the master key,
  but new files and folders take keys from a pool of 2000 made while unlocked;
  when it runs out the sync waits for `onegy unlock`. Leave a server that
  creates many files unlocked.
- Updating: rerun the `cli.sh` line (it replaces a stale binary), then
  `sudo systemctl restart onegy`. The sync commands and the daemon never
  update themselves.
- Large trees: raise `fs.inotify.max_user_watches` if a sync reports `watch_limit`.
- Engine log: `~/.local/share/onegy/logs/engine.log`.

## Packages

- `cmd/onegy`: the binary. `main.go` dispatches; `cmd_upload.go`/`cmd_download.go`
  are the file commands, `release_sign.go` the update signing (build side and
  client check), `daemon.go` the engine, `ipc.go` the RPC tool,
  `platform_*.go` the per-OS bits.
- `e2ee`: AES-256-GCM chunked container, split-key derivation, key wrapping.
- `internal/config`: state dir, socket path, `engine.json`, lock file, version.
- `internal/logx`: size-rotated `logs/engine.log`, live log level, file-name redaction.
- `internal/state`: SQLite state DB (WAL, synchronous=FULL), numbered migrations, typed accessors.
- `internal/keystore`: OS key store (go-keyring) with memory-only mode; never writes secrets to disk.
- `internal/api`: HTTP client for every sync-API route, typed errors, retry/backoff, devtls gate.
- `internal/account`: device authorization, master-key unwrap, unlock, sign-out, revocation.
- `internal/remote`: cached remote tree (snapshot + change feed), name decryption, folder create, poller.
- `internal/ipc`: JSON-RPC 2.0 server over a 0600 Unix socket (peer uid checked) or a per-user named pipe.
- `internal/localfs`: per-OS file system primitives (no-follow stat with file identity, atomic rename, debris, snapshot opens, name mapping).
- `internal/ignore`: `.onegyignore` parser and matcher.
- `internal/scan`: full walk of a sync root with the hash cache.
- `internal/watch`: change hints (inotify / ReadDirectoryChangesW / polling).
- `internal/cloudfiles`: Windows File Explorer status (Cloud Files sync roots, full placeholders marked in sync; setting `windows_explorer_status`, off by default).
- `internal/reconcile`: pure three-way reconciler; the op contract is the doc of `reconcile/ops.go`.
- `internal/exec`: journal (planned → staged → remote_done/local_done → committed), recovery, upload/download pipelines, remote and local mutations, transfer pool, manual transfers.
- `internal/syncer`: per-sync runner (schedule, passes until the plan is empty, loop protection, issues and decisions, preview, verify) and the manager.
- `internal/service`: wiring and the IPC method table, settings, sync configuration and setup rules.
- `internal/fakeserver`: in-memory sync-API server for tests (uploads, sessions, mutations, website helpers, nonce-reuse check).

## Tests

- `go test ./...` includes the model-based test (`internal/syncer/model_test.go`):
  2-3 simulated devices and the website against the fake server, random
  operations, crashes at every journal boundary; `MODEL_RUNS=2000` for more,
  `MODEL_SEED=n` to replay one run. On Linux it runs on `/dev/shm` when present.
- Live test against a DEV server (never in CI):
  `ONEGY_LIVE_SERVER=https://… ONEGY_LIVE_USER=… ONEGY_LIVE_PASS=… go test -tags livedev -run TestLive -v ./internal/syncer/`
  (use a throwaway account; `ONEGY_LIVE_DEVTLS=1` for a self-signed server).
