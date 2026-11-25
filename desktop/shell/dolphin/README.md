# Dolphin overlay plugin

Sync status emblems on the items in ONE.GY sync folders in Dolphin (KDE),
for KDE Frameworks 5 and 6 from one source (`onegy-overlay.cpp`, a
`KOverlayIconPlugin`). The "Open on one.gy" context menu entry is not here:
the app writes it per user as a KIO service menu
(`desktop/app/src/main/shell-kde.js`).

## How it works

- Dolphin loads every plugin in `<Qt plugin dir>/kf5/overlayicon` (KF5) or
  `kf6/overlayicon` (KF6) and calls `getOverlays(url)` on its GUI thread for
  each item it shows. The plugin answers from its cache at once (nothing while
  it does not know), queues the path, and every 50 ms sends the queue as one
  `files.status` call. Answers that change an item's state emit
  `overlaysChanged`, and Dolphin asks again.
- Engine connection as in `desktop/docs/engine-ipc.md` "File manager
  integration": the socket and `hello_key` from
  `$XDG_DATA_HOME/onegy/engine.json` (default `~/.local/share`), `ipc.hello`
  with a random nonce and a `key_proof` check (HMAC-SHA256), then
  `files.subscribe`. A `files` event re-queries the cached items under its
  `root`. Without the engine (or a wrong proof) there are no overlays and the
  plugin retries every 1 s, backing off to 15 s.
- Emblem names: `onegy-synced`, `onegy-syncing`, `onegy-error`,
  `onegy-paused`, the SVGs the app installs in the user's
  `hicolor/scalable/emblems` (`shell-linux.js`). Breeze falls back to hicolor
  for them.

## Build and install

`bash build.sh` builds both into `desktop/app/resources/dolphin/kf5|kf6/`
in containers (docker or podman): KF5 on Ubuntu 22.04 (Qt 5.15, KF 5.92),
KF6 on Debian 13 (Qt 6.8, KF 6.13). Qt refuses a plugin built against a newer
Qt minor version than it runs, so the KF6 build needs Qt 6.8 or later.
`bash build.sh --here kf6 <out_dir>` builds with the local dev packages
(`qtbase5-dev libkf5kio-dev` or `qt6-base-dev libkf6kio-dev`, plus cmake,
make, g++).

CI (`.github/workflows/desktop-release.yml`) runs `build.sh` before
packaging; electron-builder ships both files as `resources/dolphin/...` and
the deb / rpm `build/linux/after-install.sh` copies them into each Qt 5 / Qt 6
plugin dir it finds (`after-remove.sh` deletes them). The AppImage cannot
install system files, so it has the service menu but no overlays. Dolphin
loads the plugin at start: a running Dolphin shows the overlays after a
restart.

Tested in Dolphin 21.12 (Ubuntu 22.04, KF 5.92), 23.08 (Ubuntu 24.04,
KF 5.115), 25.04 (Debian 13, KF 6.13) and 26.08 (Fedora 44, KF 6.32).
