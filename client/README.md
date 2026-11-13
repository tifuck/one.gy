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
bash build.sh                                   # CLI builds for /static/cli/ (DOMAIN from ../.env)
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./cmd/onegy   # release cross-compile
go build -tags devtls -o bin/onegy ./cmd/onegy  # allows `daemon --insecure-tls` (local DEV server only)
./bin/onegy daemon --state-dir /tmp/e --socket /tmp/e.sock      # run the engine by hand
./bin/onegy ipc --socket /tmp/e.sock call engine.info           # talk to a running engine
```

## Commands

- `onegy upload <file>` / `onegy download <url>`: anonymous E2EE temp upload and
  share-link download. These self-update from `/cli/version` unless the build is
  `-X main.bundled=1` (the desktop app's copy updates with the app).
- `onegy daemon [--state-dir --socket --log-level --ipc-secret-stdin --insecure-tls]`:
  the sync engine (flags, single-instance lock, log file, IPC listener). Not on
  macOS yet (`localfs`/`watch` have no darwin port), so macOS builds ship the
  file commands only.
- `onegy ipc call <method> [json]` / `onegy ipc watch`: developer tool for the
  engine's JSON-RPC interface.

## Packages

- `cmd/onegy`: the binary. `main.go` dispatches; `cmd_upload.go`/`cmd_download.go`
  are the file commands, `daemon.go` the engine, `ipc.go` the RPC tool,
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
