# ONE.GY Desktop app (Electron)

The window, tray and native sync screens. Syncing itself happens in the Go
engine (`../engine`); the app talks to it over the socket/pipe described in
`../docs/engine-ipc.md`. No native Node modules.

## Run

```bash
npm ci
npm run dev:mock     # against dev/mock-engine.js (seeded syncs, transfers, issues)
npm run build:engine && npm start   # against the real engine (needs Go)
npm test             # unit tests: settings store, notifications, JSON-RPC + supervisor vs the mock
```

Dev-only flags (ignored in packaged builds): `--mock-engine`, `--server=https://…`
(sets the server URL; only https is accepted). F12 opens DevTools in dev.
To work on the native screens in a plain browser, serve `src/ui/` and load
`dev/mock-core.js` + `dev/ui-stub.js` before the page (they stand in for the
preload).

End to end without a display: `dev/browser-bridge.js` serves `src/ui` on
127.0.0.1 and proxies `window.onegy` (`dev/bridge-client.js`) to a real
engine it supervises; `test/e2e_bridge.py` drives the real UI through it with
Playwright against a DEV server (setup, sync both ways, engine restart,
conflict, backup, pause, remove; screenshots). See the header of that script;
it only runs with `ONEGY_E2E=1`. `dev/` and `test/` are never packaged.

## Package

```bash
npm run dist                          # engine + installers for this OS into dist/
node scripts/dist.js --linux AppImage deb
```

The version comes from `../VERSION` (`package.json` keeps `0.0.0-dev`).
Release builds run in `.github/workflows/desktop-release.yml`: Windows NSIS
(`ONE.GY-Desktop-Setup.exe`), Linux AppImage (`ONE.GY-Desktop-x86_64.AppImage`)
and deb (`onegy-desktop_amd64.deb`), plus `latest*.yml` / `beta*.yml` for
auto-update. Builds are unsigned for now. Icons: `npm run icons` regenerates
`build/` and `src/assets/` from `scripts/make-icons.js`.

## Structure

```
src/main/       main process
  main.js         lifecycle, single instance, autostart, close-to-tray, power-save, quit
  window.js       BaseWindow + chrome view (app://ui) + site view (persist:onegy)
  protocol.js     app:// scheme serving src/ui with a strict CSP
  security.js     web preferences, navigation locks, permissions, TLS, downloads
  engine.js       engine supervisor (connect, spawn, restart with backoff)
  rpc.js          JSON-RPC 2.0 client, newline framing
  ipc.js          ipcMain handlers: engine method whitelist + app actions + site unlock
  ui-methods.js   the engine methods the native UI may call
  environment.js  battery (powerMonitor) and metered network -> engine.environment
  remove-sync.js  remove a sync; optionally move its folder to the system trash
  tray.js, notify.js, updater.js, settings-store.js
src/preload/    app-preload (native UI bridge), site-preload (window.onegyDesktop)
src/ui/         native screens, plain ES modules, no build step
  app.js          shell: rail, router, site toolbar, status bar
  store.js        state fed by engine events + bridge wrappers
  screens/        wizard, syncs, transfers, issues, settings
  components/     dialog, menu, toast, tree picker, sync options, formatting
  styles/         UI v2 tokens and primitives copied from the website, app.css
dev/            mock engine, browser stub, browser bridge to the real engine
scripts/        build-engine, dist, make-icons
test/           node --test, plus the env-gated e2e_bridge.py
```

## Notes

- Auto-update (electron-updater, generic provider on this repo's latest GitHub
  release) runs only in packaged NSIS and AppImage builds; deb installs update
  through the package manager. The beta channel reads `beta*.yml`, which every
  release also carries.
- The website gets one bridge, `window.onegyDesktop.unlock()`, on top-level
  frames of the configured server only; the main process re-checks the frame
  and the engine's `web_unlock` setting decides.
- After a POST/PUT/PATCH/DELETE to the server from the site view, the app asks
  the engine to poll (`engine.nudge`).
