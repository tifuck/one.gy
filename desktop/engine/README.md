# onegy-engine

Go sync engine for ONE.GY Desktop. Contracts: `../docs/engine-ipc.md` (app ↔
engine) and `../docs/sync-api.md` (engine ↔ server). Crypto comes from the
shared `onegy/e2ee` package in `../../cli_E2EE_binary/e2ee` (`replace` in `go.mod`).

```bash
go test ./... && go build ./cmd/...
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ./...      # release cross-compile
go build -tags devtls ./cmd/onegy-engine                     # allows --insecure-tls (local DEV server only)
onegyctl --socket /tmp/e.sock call engine.info               # talk to a running engine
```

## Packages

- `cmd/onegy-engine`: the engine binary (flags, single-instance lock, log file, IPC listener).
- `cmd/onegyctl`: dev CLI, `call <method> [json]` and `watch` (events).
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
