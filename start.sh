#!/bin/bash
set -euo pipefail

# Anchor every path to this script's own directory so db-upgrade,
# startup-maintenance and gunicorn never depend on the caller's cwd
# (systemd WorkingDirectory, a stray `cd`, cron, etc.) and so the venv
# binaries are used instead of whatever happens to be in PATH.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/venv/bin/activate"

if [[ ! -x "$SCRIPT_DIR/venv/bin/flask" || ! -x "$SCRIPT_DIR/venv/bin/gunicorn" ]]; then
    echo "start.sh: missing venv executables under $SCRIPT_DIR/venv/bin — run venv creation / pip install first." >&2
    exit 1
fi

"$SCRIPT_DIR/venv/bin/flask" --app app db-upgrade
"$SCRIPT_DIR/venv/bin/flask" --app app startup-maintenance
exec "$SCRIPT_DIR/venv/bin/gunicorn" -c "$SCRIPT_DIR/gunicorn.conf.py" app:app
