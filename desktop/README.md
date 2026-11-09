# ONE.GY Desktop

Desktop client for one.gy (Windows and Linux): the website's Files, Notes and
Music pages in a native window, plus live, end-to-end encrypted folder sync.

Download: GitHub Releases of this repository (`desktop-v*` tags).

## Layout

```
desktop/
  VERSION                 single version for app + engine (bump to release)
  docs/
    sync-api.md           server ↔ engine HTTP contract
    engine-ipc.md         app ↔ engine JSON-RPC contract
  engine/                 Go: sync engine (onegy-engine) + dev CLI (onegyctl)
    cmd/                  binaries
    internal/             one package per concern (see engine/README.md)
  app/                    Electron: window, tray, native sync UI
    src/main/             main process (window, tray, engine supervisor, updater)
    src/preload/          app-preload (native UI bridge), site-preload (website bridge)
    src/ui/               native screens (vanilla ES modules, no build step)
```

The E2EE file format and key wrapping live in one Go package shared with the
CLI: `cli_E2EE_binary/e2ee`. It stays byte-compatible with `static/crypto.js`
and `tests/crypto_helper.js`.

## Build

```bash
# engine (needs Go ≥ 1.22)
cd desktop/engine && go test ./... && go build ./cmd/...
# app (needs Node ≥ 20); copies the engine binary into resources at package time
cd desktop/app && npm ci && npm start          # dev run
cd desktop/app && npm run dist                 # installers into desktop/app/dist
```

End-to-end check of app + engine + a DEV server without a display:
`desktop/app/test/e2e_bridge.py` (see `app/README.md`).

## Release

1. Bump `desktop/VERSION` in DEV and commit.
2. Deploy/publish as usual (`merge-to-prod.sh` publishes to GitHub).
3. `.github/workflows/desktop-release.yml` sees the new version on `main`,
   builds Windows (NSIS) and Linux (AppImage, deb) installers and attaches them
   to a `desktop-v<version>` release. The one.gy `/desktop` page links to the
   latest release.
