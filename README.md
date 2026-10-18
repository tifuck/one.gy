# ONE.GY

Self-hosted, end-to-end encrypted file sharing and backup: files, notes and a music library. Flask + MariaDB, a vanilla JS frontend and a Go CLI for E2EE uploads and downloads. Files can be replicated to S3-compatible or SSH storage nodes.

## Requirements
- Linux, Python 3.12, MariaDB (or MySQL)
- Go 1.22 (to build the CLI that the site serves)
- A TLS certificate. Gunicorn serves HTTPS directly from `cert.pem` / `key.pem` in the app folder.

## Setup
```bash
git clone https://github.com/tifuck/one.gy.git && cd one.gy
python3 -m venv venv && venv/bin/pip install -r requirements.txt

# Database
sudo mysql -e "CREATE DATABASE onegy CHARACTER SET utf8mb4; \
  CREATE USER 'onegy'@'localhost' IDENTIFIED BY 'change-me'; \
  GRANT ALL ON onegy.* TO 'onegy'@'localhost';"

# Config: fill in SECRET_KEY, FERNET_KEY, DATABASE_URL and DOMAIN
cp .env.example .env && chmod 600 .env
python3 -c 'import secrets; print(secrets.token_hex(32))'                                          # SECRET_KEY
venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'  # FERNET_KEY

# TLS (self-signed shown; use a real cert or put a reverse proxy in front)
openssl req -x509 -newkey rsa:4096 -nodes -days 365 -subj "/CN=localhost" -keyout key.pem -out cert.pem

# CLI binaries (compiled with DOMAIN from .env, written to static/cli/)
(cd cli_E2EE_binary && bash build.sh)

# Run: creates and upgrades the schema, then starts gunicorn on BIND_HOST:WEB_PORT (default 0.0.0.0:5000)
bash start.sh
```

Register an account in the browser, then make it an admin:
```bash
venv/bin/python manage_users.py promote <username>
```

> [!WARNING]
> Back up `.env`. Losing `FERNET_KEY` makes server-side encrypted data and storage-node credentials unrecoverable.

## systemd
```ini
[Unit]
Description=ONE.GY
After=network.target mariadb.service

[Service]
WorkingDirectory=/opt/one.gy
ExecStart=/bin/bash /opt/one.gy/start.sh
Restart=always
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

## Configuration
- `.env` holds secrets and per-deployment settings; every variable is documented in `.env.example`.
- Feature flags and tunables can be changed at runtime in the admin UI. These DB settings override the `.env` defaults.
- Music library: set `MUSIC_LIBRARY_PATH` (default `<home>/music`). Keep it outside the app folder.
- User uploads go to `uploads/`, `thumbnails/` and `notes/` in the app folder. Storage nodes are added in the admin UI.

## License
MIT. See `LICENSE`.
