# ONE.GY Desktop

Desktop client for one.gy (Windows and Linux): files, notes, music and (for
admins) the admin console in a desktop window, plus live, end-to-end
encrypted folder sync. You sign in once in the app; its "Sync" entry manages
sync in a native panel.

Download: GitHub Releases of this repository (`desktop-v*` tags): Windows
installer `ONE.GY-Desktop-Setup.exe`, Linux installers `onegy-desktop_amd64.deb`
(Ubuntu, Debian, Mint) and `onegy-desktop.x86_64.rpm` (Fedora, openSUSE, RHEL),
and the portable `ONE.GY-Desktop-x86_64.AppImage`. All of them update themselves.

## Layout

```
desktop/
  VERSION                 single version for app + engine (bump to release)
  docs/
    sync-api.md           server ↔ engine HTTP contract
    engine-ipc.md         app ↔ engine JSON-RPC contract
    site-bridge.md        website ↔ app contract (window.onegyDesktop)
  engine/                 Go: sync engine (onegy-engine) + dev CLI (onegyctl)
    cmd/                  binaries
    internal/             one package per concern (see engine/README.md)
  app/                    Electron: window, tray, native sync panel
    src/main/             main process (window, tray, engine supervisor, updater)
    src/preload/          app-preload (panel bridge), titlebar-preload, site-preload (website bridge)
    src/ui/               sync panel screens (vanilla ES modules, no build step)
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
2. Promote as usual (`bash promote-to-prod.sh` deploys to PROD and publishes to GitHub).
3. `.github/workflows/desktop-release.yml` sees the new version on `main`,
   builds Windows (NSIS) and Linux (deb, rpm, AppImage) packages and attaches
   them to a `desktop-v<version>` release. The one.gy `/desktop` page links to the
   latest release.
