#!/bin/bash
###############################################################################
#  build.sh — Cross-compile the onegy CLI binary for all supported platforms
#             and generate a SHA-256 manifest for auto-update.
#
#  Usage:  cd cli_E2EE_binary && bash build.sh
#
#  Outputs:
#    ../static/cli/<os>-<arch>/onegy      — compiled binaries
#    ../static/cli/manifest.json           — SHA-256 hashes per platform
#
#  Requires: Go 1.22+ in PATH
###############################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTDIR="$PROJECT_DIR/static/cli"
ENV_FILE="$PROJECT_DIR/.env"

# Read DOMAIN using dotenv quoting/comment rules, then require a bare hostname
# (with an optional port). Schemes, paths, credentials, and malformed DNS names
# would produce an unsafe or unusable compile-time base URL.
if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi
DOMAIN="$(python3 - "$ENV_FILE" <<'PY'
import ipaddress
import re
import shlex
import sys
from urllib.parse import urlsplit

value = None
with open(sys.argv[1], encoding='utf-8') as env_file:
    for line in env_file:
        match = re.match(r'^\s*(?:export\s+)?DOMAIN\s*=\s*(.*)$', line)
        if not match:
            continue
        lexer = shlex.shlex(match.group(1), posix=True)
        lexer.whitespace_split = True
        lexer.commenters = '#'
        fields = list(lexer)
        if len(fields) != 1:
            raise SystemExit('ERROR: DOMAIN must contain exactly one dotenv value')
        value = fields[0]

if not value:
    raise SystemExit('ERROR: DOMAIN is empty or missing')
if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
    raise SystemExit('ERROR: DOMAIN contains whitespace or control characters')

parsed = urlsplit('//' + value)
if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
    raise SystemExit('ERROR: DOMAIN must be a hostname with an optional port, not a URL')
try:
    host = parsed.hostname
    port = parsed.port
except ValueError as exc:
    raise SystemExit(f'ERROR: invalid DOMAIN port: {exc}')
if not host:
    raise SystemExit('ERROR: DOMAIN has no hostname')
if port is not None and not 1 <= port <= 65535:
    raise SystemExit('ERROR: DOMAIN port must be between 1 and 65535')

try:
    ipaddress.ip_address(host)
except ValueError:
    if len(host) > 253 or any(
        not label or len(label) > 63 or
        not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?', label)
        for label in host.rstrip('.').split('.')
    ):
        raise SystemExit('ERROR: DOMAIN contains an invalid hostname')

print(value)
PY
)"
if [[ -z "$DOMAIN" ]]; then
    echo "ERROR: DOMAIN not found in $ENV_FILE"
    exit 1
fi

echo "Building onegy CLI for domain: $DOMAIN"
echo ""

# Build away from the live output and publish only after every target and the
# manifest have been validated.
mkdir -p "$(dirname "$OUTDIR")"
STAGING="$(mktemp -d "$(dirname "$OUTDIR")/.cli-build.XXXXXX")"
PUBLISH_TMP=""
cleanup() {
    if [[ -n "$PUBLISH_TMP" ]]; then
        rm -f "$PUBLISH_TMP"
    fi
    if [[ -n "$STAGING" ]]; then
        rm -rf "$STAGING"
    fi
}
trap cleanup EXIT

# Target platforms
TARGETS=(
    "linux/amd64"
    "linux/arm64"
    "darwin/amd64"
    "darwin/arm64"
)

# Ensure Go modules are available without mutating go.mod/go.sum during deploy
cd "$SCRIPT_DIR"
export PATH="$PATH:/usr/local/go/bin"
# Unattended shells (e.g. the systemd merge-to-prod run) may not have $HOME set,
# in which case Go cannot derive GOPATH ($HOME/go) and dies with
# "module cache not found: neither GOMODCACHE nor GOPATH is set". Pin them so the
# build works regardless of the ambient environment.
export GOPATH="${GOPATH:-${HOME:-/root}/go}"
export GOMODCACHE="${GOMODCACHE:-$GOPATH/pkg/mod}"
go mod download

# Cross-compile each target
for target in "${TARGETS[@]}"; do
    GOOS="${target%/*}"
    GOARCH="${target#*/}"
    PLATFORM="${GOOS}-${GOARCH}"
    OUTPATH="$STAGING/$PLATFORM"
    BINARY="$OUTPATH/onegy"

    echo -n "  Building $PLATFORM... "
    mkdir -p "$OUTPATH"

    CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" go build -mod=readonly \
        -ldflags "-s -w -X main.serverDomain=$DOMAIN" \
        -o "$BINARY" .

    chmod +x "$BINARY"
    SIZE=$(stat -c%s "$BINARY" 2>/dev/null || stat -f%z "$BINARY" 2>/dev/null)
    MB=$(awk "BEGIN {printf \"%.1f\", $SIZE/1048576}")
    echo "done (${MB} MB)"
done

echo ""
echo "Generating manifest.json..."

# Generate manifest.json with SHA-256 per binary
python3 -c "
import hashlib, json, os, sys

outdir = sys.argv[1]
manifest = {}

for dirname in sorted(os.listdir(outdir)):
    binary_path = os.path.join(outdir, dirname, 'onegy')
    if os.path.isfile(binary_path):
        with open(binary_path, 'rb') as f:
            h = hashlib.sha256(f.read()).hexdigest()
        manifest[dirname] = {
            'sha256': h,
            'download_url': '/static/cli/' + dirname + '/onegy',
            'size': os.path.getsize(binary_path)
        }

manifest_path = os.path.join(outdir, 'manifest.json')
with open(manifest_path, 'w') as f:
    json.dump(manifest, f, indent=2)

print('  manifest.json written with', len(manifest), 'platforms')
for plat, info in manifest.items():
    print(f'    {plat}: {info[\"sha256\"][:16]}... ({info[\"size\"]} bytes)')
" "$STAGING"

python3 - "$STAGING" "${TARGETS[@]}" <<'PY'
import hashlib
import json
import os
import sys

outdir = sys.argv[1]
expected = {target.replace('/', '-') for target in sys.argv[2:]}
with open(os.path.join(outdir, 'manifest.json'), encoding='utf-8') as manifest_file:
    manifest = json.load(manifest_file)
if set(manifest) != expected:
    raise SystemExit(f'ERROR: manifest platforms {sorted(manifest)} do not match {sorted(expected)}')
for platform in expected:
    binary = os.path.join(outdir, platform, 'onegy')
    if not os.path.isfile(binary) or os.path.getsize(binary) <= 0:
        raise SystemExit(f'ERROR: missing or empty binary for {platform}')
    with open(binary, 'rb') as binary_file:
        digest = hashlib.sha256(binary_file.read()).hexdigest()
    entry = manifest[platform]
    if entry.get('sha256') != digest or entry.get('size') != os.path.getsize(binary):
        raise SystemExit(f'ERROR: manifest validation failed for {platform}')
    if entry.get('download_url') != f'/static/cli/{platform}/onegy':
        raise SystemExit(f'ERROR: invalid download URL for {platform}')
print('  all staged outputs validated')
PY

# Publish each validated file through a same-directory rename, then publish the
# manifest last. An interrupted generation therefore leaves the old manifest
# pointing at mismatched binaries and clients fail closed instead of installing
# a mixed build. This works on both Linux and Darwin build hosts.
mkdir -p "$OUTDIR"
for target in "${TARGETS[@]}"; do
    PLATFORM="${target%/*}-${target#*/}"
    mkdir -p "$OUTDIR/$PLATFORM"
    PUBLISH_TMP="$(mktemp "$OUTDIR/$PLATFORM/.onegy.XXXXXX")"
    cp "$STAGING/$PLATFORM/onegy" "$PUBLISH_TMP"
    chmod +x "$PUBLISH_TMP"
    mv "$PUBLISH_TMP" "$OUTDIR/$PLATFORM/onegy"
    PUBLISH_TMP=""
done
PUBLISH_TMP="$(mktemp "$OUTDIR/.manifest.XXXXXX")"
cp "$STAGING/manifest.json" "$PUBLISH_TMP"
mv "$PUBLISH_TMP" "$OUTDIR/manifest.json"
PUBLISH_TMP=""

echo ""
echo "Build complete. Binaries are in $OUTDIR/"
