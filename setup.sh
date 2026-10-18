#!/bin/bash
###############################################################################
#  setup.sh — interactive first-time install for ONE.GY.
#
#  Usage:  bash setup.sh
#
#  Creates the Python venv, a MariaDB database + user (optional), .env with
#  fresh keys, a TLS certificate, the E2EE CLI binaries and (optionally) a
#  systemd service. Safe to re-run: an existing venv, .env and certificate
#  are kept. The first account registered in the browser becomes the admin.
###############################################################################
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

step() { echo; echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
ask()  {  # ask <var> <prompt> [default]
    local reply
    read -rp "$2${3:+ [$3]}: " reply || true
    printf -v "$1" '%s' "${reply:-${3:-}}"
}
yes_no() {  # yes_no <prompt> <Y|N>
    local reply
    read -rp "$1 [$2]: " reply || true
    [[ "${reply:-$2}" =~ ^[Yy] ]]
}
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }

# ─── 1. Prerequisites ────────────────────────────────────────────────────────
step "Checking prerequisites"
command -v python3 >/dev/null || die "python3 not found (Debian/Ubuntu: apt install python3 python3-venv)"
python3 -c 'import venv, ensurepip' 2>/dev/null || die "python3 venv support missing (Debian/Ubuntu: apt install python3-venv)"
command -v openssl >/dev/null || die "openssl not found (apt install openssl)"
GO_BIN="$(command -v go || true)"
[[ -z "$GO_BIN" && -x /usr/local/go/bin/go ]] && GO_BIN=/usr/local/go/bin/go
[[ -n "$GO_BIN" ]] || echo "    Go not found: the downloadable CLI will be skipped (install Go 1.22+ from https://go.dev/dl/ and re-run)."
echo "    python3 $(python3 -c 'import platform; print(platform.python_version())'), openssl OK${GO_BIN:+, $("$GO_BIN" version | awk '{print $3}')}"

# ─── 2. Python environment ──────────────────────────────────────────────────
step "Installing Python dependencies into venv/"
[[ -x venv/bin/python ]] || python3 -m venv venv
venv/bin/pip install --quiet --upgrade pip
venv/bin/pip install --quiet -r requirements.txt
echo "    done"

# ─── 3. Configuration (.env) ────────────────────────────────────────────────
if [[ -f .env ]]; then
    step "Keeping existing .env"
else
    step "Configuring .env"
    ask WEB_PORT "Port for the app to listen on" 5000
    ask BIND_HOST "Address to bind (127.0.0.1 if only a local reverse proxy should reach it)" 0.0.0.0
    BEHIND_PROXY=0
    if yes_no "Will a reverse proxy (nginx, Caddy, Cloudflare...) sit in front of it?" N; then
        BEHIND_PROXY=1
        DOMAIN_DEFAULT="$(hostname -f 2>/dev/null || hostname)"
    else
        DOMAIN_DEFAULT="$(hostname -f 2>/dev/null || hostname):$WEB_PORT"
    fi
    echo "    DOMAIN is the host users type in the browser, with :port unless served on 443."
    ask DOMAIN "Domain" "$DOMAIN_DEFAULT"

    if command -v mysql >/dev/null && yes_no "Create a local MariaDB/MySQL database and user now (needs root/sudo)?" Y; then
        ask DB_NAME "Database name" onegy
        ask DB_USER "Database user" onegy
        DB_PASS="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
        [[ "$DB_NAME$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "database and user names may only use letters, digits and _"
        as_root mysql -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
            CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
            ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
            GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;"
        DATABASE_URL="mysql+pymysql://$DB_USER:$DB_PASS@localhost:3306/$DB_NAME?charset=utf8mb4"
        echo "    created database '$DB_NAME' and user '$DB_USER' (random password stored in .env)"
    else
        echo "    Format: mysql+pymysql://USER:PASSWORD@HOST:3306/DBNAME?charset=utf8mb4"
        ask DATABASE_URL "DATABASE_URL"
        [[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is required"
    fi

    cp .env.example .env
    chmod 600 .env
    SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')" \
    FERNET_KEY="$(venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')" \
    DATABASE_URL="$DATABASE_URL" DOMAIN="$DOMAIN" WEB_PORT="$WEB_PORT" BIND_HOST="$BIND_HOST" \
    TRUSTED_PROXY_HOPS="$BEHIND_PROXY" \
    venv/bin/python - <<'PY'
import os, re
keys = ['SECRET_KEY', 'FERNET_KEY', 'DATABASE_URL', 'DOMAIN', 'WEB_PORT', 'BIND_HOST', 'TRUSTED_PROXY_HOPS']
text = open('.env', encoding='utf-8').read()
for key in keys:
    line = f'{key}={os.environ[key]}'
    pattern = rf'^#?{key}=.*$'
    if re.search(pattern, text, flags=re.M):
        text = re.sub(pattern, lambda _: line, text, count=1, flags=re.M)
    else:
        text += f'\n{line}\n'
open('.env', 'w', encoding='utf-8').write(text)
PY
    echo "    wrote .env (SECRET_KEY and FERNET_KEY generated)"
    echo "    BACK UP .env: losing FERNET_KEY makes server-side encrypted data unrecoverable."
fi

# ─── 4. TLS certificate (gunicorn serves HTTPS from cert.pem / key.pem) ─────
if [[ -e cert.pem && -e key.pem ]]; then
    step "Keeping existing cert.pem / key.pem"
else
    step "TLS certificate"
    echo "    1) self-signed (fine behind a proxy, or for testing)"
    echo "    2) link an existing certificate (e.g. Let's Encrypt fullchain.pem + privkey.pem)"
    ask TLS_CHOICE "Choose" 1
    if [[ "$TLS_CHOICE" == 2 ]]; then
        ask CERT_PATH "Certificate path" "/etc/letsencrypt/live/$(grep -m1 '^DOMAIN=' .env | cut -d= -f2 | cut -d: -f1)/fullchain.pem"
        ask KEY_PATH "Private key path" "${CERT_PATH%/*}/privkey.pem"
        [[ -r "$CERT_PATH" && -r "$KEY_PATH" ]] || die "cannot read $CERT_PATH or $KEY_PATH"
        ln -sf "$CERT_PATH" cert.pem
        ln -sf "$KEY_PATH" key.pem
        echo "    linked (renewals are picked up on restart)"
    else
        openssl req -x509 -newkey rsa:4096 -nodes -days 825 -subj "/CN=$(hostname)" \
            -keyout key.pem -out cert.pem 2>/dev/null
        chmod 600 key.pem
        echo "    created a self-signed certificate (browsers will warn until you use a real one)"
    fi
fi

# ─── 5. Database schema ─────────────────────────────────────────────────────
step "Creating / upgrading the database schema"
venv/bin/flask --app app db-upgrade >/dev/null || die "db-upgrade failed — check DATABASE_URL in .env"
echo "    done"

# ─── 6. E2EE CLI binaries ───────────────────────────────────────────────────
if [[ -n "$GO_BIN" ]]; then
    step "Building the CLI binaries (served from /cli)"
    PATH="$(dirname "$GO_BIN"):$PATH" bash cli_E2EE_binary/build.sh >/dev/null
    echo "    done"
fi

# ─── 7. Service ─────────────────────────────────────────────────────────────
PORT="$(grep -m1 '^WEB_PORT=' .env | cut -d= -f2)"
PORT="${PORT:-5000}"
SITE="$(grep -m1 '^DOMAIN=' .env | cut -d= -f2)"
STARTED=0
if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]] \
        && yes_no "Install and start a systemd service (onegy.service)?" Y; then
    RUN_USER="$(stat -c %U "$APP_DIR")"
    as_root tee /etc/systemd/system/onegy.service >/dev/null <<EOF
[Unit]
Description=ONE.GY
After=network-online.target mariadb.service mysql.service

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=/bin/bash $APP_DIR/start.sh
Restart=always
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
    as_root systemctl daemon-reload
    as_root systemctl enable --now onegy.service
    STARTED=1
    echo "    started; logs: journalctl -u onegy -f"
fi

# ─── 8. First admin ─────────────────────────────────────────────────────────
step "Next: create the admin account"
[[ "$STARTED" == 1 ]] || echo "    Start the server:  bash start.sh"
echo "    Open https://$SITE/register and register NOW."
echo "    The FIRST account registered becomes the administrator. Registration is"
echo "    open to anyone, so do this before sharing the address. To run a private"
echo "    instance, turn off registration afterwards in the Admin settings."
echo "    (Local check: curl -kI https://127.0.0.1:$PORT/)"
