# ONE.GY

Self-hosted, end-to-end encrypted file sharing and backup: files, notes and a music library. Flask + MariaDB, a vanilla JS frontend and a Go CLI for E2EE uploads and downloads. Files can be replicated to S3-compatible or SSH storage nodes.

## Requirements
- Linux with systemd (optional), Python 3.12 with `venv`, OpenSSL
- MariaDB or MySQL
- Go 1.22+ (optional; builds the CLI that the site serves for download)

On Debian/Ubuntu: `sudo apt install python3 python3-venv mariadb-server openssl`, plus Go from https://go.dev/dl/.

## Install
```bash
git clone https://github.com/tifuck/one.gy.git && cd one.gy
bash setup.sh
```
`setup.sh` walks you through everything and is safe to re-run (it keeps an existing `venv/`, `.env` and certificate):
1. installs the Python dependencies into `venv/`
2. creates a database and user (or takes your own `DATABASE_URL`)
3. writes `.env` with freshly generated `SECRET_KEY` and `FERNET_KEY`, your domain, port and bind address (behind a reverse proxy it binds to `127.0.0.1` by default and asks for `TRUSTED_PROXY_IPS`)
4. creates a self-signed certificate or links an existing one (gunicorn serves HTTPS from `cert.pem` / `key.pem`)
5. creates the database schema and builds the CLI
6. optionally installs and starts `onegy.service`

## First admin
Open `https://<your-domain>/register` and register immediately after setup. **The first account registered becomes the administrator.** For a private instance, turn registration off afterwards in the admin settings.

> [!CAUTION]
> Registration is open to anyone who can reach the server. Until you have registered, whoever gets there first claims admin, so register before you open the firewall or share the address.

> [!WARNING]
> Back up `.env`. Losing `FERNET_KEY` makes server-side encrypted data and storage-node credentials unrecoverable.

## Running
- Run `bash start.sh` or use the systemd service. Either one upgrades the schema, runs startup maintenance, then starts gunicorn on `BIND_HOST:WEB_PORT`.
- Logs: `journalctl -u onegy -f`.
- To update: `git pull`, `venv/bin/pip install -r requirements.txt`, rebuild the CLI with `(cd cli_E2EE_binary && bash build.sh)`, then `sudo systemctl restart onegy`.

## Configuration
- `.env` holds secrets and per-deployment settings. Every variable is documented in `.env.example`.
- Feature flags and tunables can be changed at runtime in the admin UI. These DB settings override the `.env` defaults.
- Behind a reverse proxy, set `TRUSTED_PROXY_HOPS` to the number of proxies and `TRUSTED_PROXY_IPS` to their addresses or CIDRs (comma-separated). `X-Forwarded-*` headers are then honoured only from those peers. Bind to `127.0.0.1` when the proxy runs on the same machine; otherwise firewall `WEB_PORT` so clients cannot bypass the proxy and forge `X-Forwarded-For`.
- Music library: set `MUSIC_LIBRARY_PATH` (default `<home>/music`). Keep it outside the app folder.
- User data lives in `uploads/`, `thumbnails/` and `notes/` in the app folder. Storage nodes are added in the admin UI.

## License
MIT. See `LICENSE`.
