# ONE.GY Desktop

Desktop client for one.gy (Windows and Linux): the website in its own window,
plus live, end-to-end encrypted folder sync. Once you sign in on the site, its
"Sync" nav entry sets up and manages sync in a panel over the site.

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
    src/preload/          app-preload (panel bridge), site-preload (website bridge)
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
2. Deploy/publish as usual (`merge-to-prod.sh` publishes to GitHub).
3. `.github/workflows/desktop-release.yml` sees the new version on `main`,
   builds Windows (NSIS) and Linux (deb, rpm, AppImage) packages and attaches
   them to a `desktop-v<version>` release. The one.gy `/desktop` page links to the
   latest release.
