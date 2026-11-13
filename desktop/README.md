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
client/                   Go: the onegy binary (CLI + sync engine), see client/README.md
  VERSION                 single version for the binary and the app (bump to release)
desktop/
  docs/
    sync-api.md           server ↔ engine HTTP contract
    engine-ipc.md         app ↔ engine JSON-RPC contract
    site-bridge.md        website ↔ app contract (window.onegyDesktop)
  app/                    Electron: window, tray, native sync panel
    src/main/             main process (window, tray, engine supervisor, updater)
    src/preload/          app-preload (panel bridge), titlebar-preload, site-preload (website bridge)
    src/ui/               sync panel screens (vanilla ES modules, no build step)
```

The app bundles the same `onegy` binary the website serves as the CLI and
runs it as `onegy daemon` (the sync engine). The deb/rpm installers link it as
`/usr/bin/onegy` and the Windows installer adds it to the user PATH, so the
command works in a terminal too (the AppImage, which installs nothing, does not). The E2EE file format and key
wrapping live in its one Go package, `client/e2ee`, byte-compatible with
`static/crypto.js` and `tests/crypto_helper.js`. The site view loads the
website itself, and the sync panel uses the website's CSS and fonts
(`npm run vendor` copies them from `static/`), so no site code is copied.

## Build

```bash
# onegy binary (needs Go ≥ 1.22)
cd client && go test ./... && go build ./cmd/onegy
# app (needs Node ≥ 20); `npm run build:engine` builds onegy into resources/engine/
cd desktop/app && npm ci && npm start          # dev run
cd desktop/app && npm run dist                 # installers into desktop/app/dist
```

End-to-end check of app + engine + a DEV server without a display:
`desktop/app/test/e2e_bridge.py` (see `app/README.md`).

## Release

1. Bump `client/VERSION` in DEV and commit.
2. Promote as usual (`bash promote-to-prod.sh` deploys to PROD and publishes to GitHub).
3. `.github/workflows/desktop-release.yml` sees the new version on `main`,
   builds Windows (NSIS) and Linux (deb, rpm, AppImage) packages and attaches
   them to a `desktop-v<version>` release. The one.gy `/desktop` page links to the
   latest release.
