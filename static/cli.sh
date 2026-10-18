#!/bin/bash
###############################################################################
#  cli.sh — Bootstrap script for the onegy E2EE CLI tool
#
#  Usage:
#    curl -fsSL https://DOMAIN/cli.sh | bash -s -- upload file.pdf
#    curl -fsSL https://DOMAIN/cli.sh | bash -s -- download "https://..."
#
#  What this script does:
#    1. Detects your OS and architecture
#    2. Downloads the onegy binary to ~/.onegy/bin/ if not already present,
#       OR re-downloads it if the installed binary's SHA-256 doesn't match
#       the server manifest (catches domain-miscompiled or stale binaries)
#    3. Runs the binary with your arguments
#
#  The binary also auto-updates itself on subsequent runs.
###############################################################################

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
# SERVER is replaced at serve-time by the Flask route, or hardcoded for static serving
SERVER="%%SERVER_URL%%"

INSTALL_DIR="$HOME/.onegy/bin"
BINARY="$INSTALL_DIR/onegy"
TMP_BINARY=""

cleanup() {
    if [[ -n "$TMP_BINARY" ]]; then
        rm -f "$TMP_BINARY"
    fi
}

with_deadline() {
    local seconds="$1"
    shift
    if command -v timeout &>/dev/null; then
        timeout "${seconds}s" "$@"
    elif command -v gtimeout &>/dev/null; then
        gtimeout "${seconds}s" "$@"
    else
        "$@"
    fi
}
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# ─── Detect OS and Architecture ──────────────────────────────────────────────
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux"  ;;
        Darwin*) os="darwin" ;;
        *)
            echo "Error: unsupported operating system: $(uname -s)" >&2
            echo "Supported: Linux, macOS" >&2
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64)  arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            echo "Error: unsupported architecture: $(uname -m)" >&2
            echo "Supported: x86_64/amd64, aarch64/arm64" >&2
            exit 1
            ;;
    esac

    echo "${os}-${arch}"
}

# sha256_file <path> — prints the lowercase hex SHA-256 of a file
sha256_file() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo ""
    fi
}

# ─── Ensure correct binary is installed ──────────────────────────────────────
ensure_binary() {
    local platform
    platform="$(detect_platform)"

    local manifest_url="${SERVER}/cli/version?platform=${platform}"
    local download_url="${SERVER}/static/cli/${platform}/onegy"

    if ! command -v sha256sum &>/dev/null && ! command -v shasum &>/dev/null; then
        echo "Error: sha256sum or shasum is required to verify the onegy binary" >&2
        exit 1
    fi

    # Fetch the expected SHA-256 from the server manifest. This is required:
    # never install or run a bootstrap-managed binary that cannot be verified.
    fetch_expected_hash() {
        if command -v curl &>/dev/null; then
            curl -fsSL --connect-timeout 10 --max-time 30 \
                --retry 3 --retry-delay 1 "$manifest_url" 2>/dev/null | \
                grep -o '"sha256"[[:space:]]*:[[:space:]]*"[^"]*"' | \
                grep -o '"[^"]*"$' | tr -d '"' | tr 'A-F' 'a-f'
        elif command -v wget &>/dev/null; then
            with_deadline 30 wget -qO- --timeout=15 --tries=3 "$manifest_url" 2>/dev/null | \
                grep -o '"sha256"[[:space:]]*:[[:space:]]*"[^"]*"' | \
                grep -o '"[^"]*"$' | tr -d '"' | tr 'A-F' 'a-f'
        else
            return 1
        fi
    }
    local expected_hash=""
    expected_hash="$(fetch_expected_hash)" || true

    if [[ ! "$expected_hash" =~ ^[0-9a-f]{64}$ ]]; then
        echo "Error: could not fetch a valid onegy binary hash from ${manifest_url}" >&2
        exit 1
    fi

    # Check if installed binary matches expected hash
    local needs_download=false
    if [[ ! -x "$BINARY" ]]; then
        needs_download=true
    else
        local current_hash
        current_hash="$(sha256_file "$BINARY")" || true
        current_hash="$(echo "$current_hash" | tr 'A-F' 'a-f')"
        if [[ -z "$current_hash" ]]; then
            echo "Error: could not compute installed binary hash" >&2
            exit 1
        fi
        if [[ "$current_hash" != "$expected_hash" ]]; then
            echo "Updating onegy CLI..." >&2
            needs_download=true
        fi
    fi

    if [[ "$needs_download" == true ]]; then
        echo "Installing onegy CLI..." >&2
        echo "  Platform:  ${platform}" >&2
        echo "  Location:  ${BINARY}" >&2

        mkdir -p "$INSTALL_DIR"
        TMP_BINARY="$(mktemp "${INSTALL_DIR}/.onegy.XXXXXX")"

        if command -v curl &>/dev/null; then
            curl -fsSL --connect-timeout 10 --max-time 300 \
                --retry 3 --retry-delay 1 \
                "$download_url" -o "$TMP_BINARY"
        elif command -v wget &>/dev/null; then
            with_deadline 300 wget -q --timeout=30 --tries=3 "$download_url" -O "$TMP_BINARY"
        else
            echo "Error: curl or wget is required to download the onegy binary" >&2
            exit 1
        fi

        local downloaded_hash
        downloaded_hash="$(sha256_file "$TMP_BINARY")" || true
        downloaded_hash="$(echo "$downloaded_hash" | tr 'A-F' 'a-f')"
        if [[ -z "$downloaded_hash" ]]; then
            echo "Error: could not compute downloaded binary hash" >&2
            exit 1
        fi
        if [[ "$downloaded_hash" != "$expected_hash" ]]; then
            # A build may atomically switch generations between the manifest and
            # binary requests. Refetch once and accept only the new signed hash.
            expected_hash="$(fetch_expected_hash)" || true
            if [[ ! "$expected_hash" =~ ^[0-9a-f]{64}$ || "$downloaded_hash" != "$expected_hash" ]]; then
                echo "Error: downloaded binary hash mismatch — aborting" >&2
                echo "  Expected: $expected_hash" >&2
                echo "  Got:      $downloaded_hash" >&2
                exit 1
            fi
        fi

        # Refetch immediately before installation so an older concurrent
        # bootstrap cannot replace a binary from a newer published generation.
        local current_expected_hash
        current_expected_hash="$(fetch_expected_hash)" || true
        if [[ ! "$current_expected_hash" =~ ^[0-9a-f]{64}$ || "$downloaded_hash" != "$current_expected_hash" ]]; then
            echo "Error: binary generation changed before installation — retrying is safe" >&2
            exit 1
        fi

        chmod +x "$TMP_BINARY"
        mv "$TMP_BINARY" "$BINARY"
        TMP_BINARY=""

        echo "  Installed successfully!" >&2
        echo "" >&2
    fi
}

# ─── Main ────────────────────────────────────────────────────────────────────

# Show help if no arguments
if [[ $# -eq 0 ]]; then
    echo "onegy — End-to-end encrypted file sharing from the terminal" >&2
    echo "" >&2
    echo "Usage:" >&2
    echo "  curl -fsSL ${SERVER}/cli.sh | bash -s -- upload <file>" >&2
    echo "  curl -fsSL ${SERVER}/cli.sh | bash -s -- download <url>" >&2
    echo "" >&2
    echo "Or install the binary directly:" >&2
    echo "  curl -fsSL ${SERVER}/cli.sh | bash -s -- version" >&2
    echo "  Then use: ~/.onegy/bin/onegy upload <file>" >&2
    exit 0
fi

ensure_binary
exec "$BINARY" "$@"
