#!/usr/bin/env bash
# ============================================================
#  crypt.sh — authenticated AES file encryption helper
#
#  AUDIT FIX F8:
#   * New format (ONEGYENC2): AES-256-CTR + HMAC-SHA256
#     (encrypt-then-MAC, PBKDF2-SHA256 310000 iters, purpose-separated
#     MAC key). `openssl enc` cannot do AEAD (no GCM/CCM), so integrity is
#     an explicit HMAC covering header + ciphertext. The MAC is verified
#     BEFORE any plaintext is written — wrong password or tampering aborts
#     with the original file untouched.
#   * Legacy files (raw openssl "Salted__" AES-256-CBC blobs written by the
#     old version of this script) still decrypt, via a backwards-compatible
#     path — but they are UNAUTHENTICATED, so they are decrypted to a temp
#     file and only moved into place on success.
#   * Every write goes to a temp file in the OUTPUT's directory and is
#     atomically renamed into place ONLY after success — a bad password can
#     never destroy an existing file (the old script let openssl truncate
#     the destination up front, so a failed decrypt destroyed the original).
#   * The password is NEVER on argv (the old script passed the secret as a
#     literal pass-argument, visible in `ps` to every local user). It reaches
#     openssl via stdin
#     (-pass stdin) or, for file mode, as a path (-pass file:PATH — only the
#     path, never the secret, appears on argv). HMAC key material is derived
#     into shell variables via `openssl enc -P` (also fed by stdin) and
#     mixed into the HMAC by piping ipad/opad blocks — no key material on
#     argv or in the environment.
# ============================================================

set -euo pipefail
# Byte-exact header-line handling for the v2 format (${#var} must count bytes,
# not locale characters) and deterministic sort in the file picker.
export LC_ALL=C

# ── colours ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
ACCENT='\033[38;2;222;24;51m'   # ONE.GY brand #DE1833

ITER=310000                 # PBKDF2 iterations (same cost as the old script)
LEGACY_ITER=310000          # iteration count baked into legacy blobs
MAGIC="ONEGYENC2"

# Temp-file slots for the EXIT/INT/TERM cleanup trap (created in step 6,
# inside the OUTPUT directory so the final rename is atomic).
TMP_OUT=""
TMP_BODY=""

_cleanup_temps() {
  if [[ -n "${TMP_OUT:-}" && -e "$TMP_OUT" ]]; then rm -f "$TMP_OUT"; fi
  if [[ -n "${TMP_BODY:-}" && -e "$TMP_BODY" ]]; then rm -f "$TMP_BODY"; fi
  tput cnorm 2>/dev/null || true
}

# ── helpers ─────────────────────────────────────────────────
header() {
  clear 2>/dev/null || true
  echo -e "${ACCENT}${BOLD}"
  echo "  ╔═══════════════════════════════════╗"
  echo "  ║   ONE.GY Authenticated Crypt      ║"
  echo "  ╚═══════════════════════════════════╝"
  echo -e "${RESET}"
}

read_key() {
  # Reads a single keypress and sets READ_KEY_RESULT to one of:
  #   "up", "down", "enter", "q", or the literal character.
  READ_KEY_RESULT=""
  local key
  IFS= read -rsn1 key 2>/dev/null || true

  # Enter key: read returns empty string
  if [[ -z "$key" ]]; then
    READ_KEY_RESULT="enter"
    return
  fi

  # Escape sequence: arrow keys send \e[A / \e[B for up/down
  if [[ "$key" == $'\x1b' ]]; then
    local rest
    IFS= read -rsn2 -t 1 rest 2>/dev/null || true
    case "$rest" in
      '[A') READ_KEY_RESULT="up"   ;;
      '[B') READ_KEY_RESULT="down" ;;
      *)    READ_KEY_RESULT=""     ;;   # ignore unknown sequences
    esac
    return
  fi

  READ_KEY_RESULT="$key"
}

arrow_menu() {
  # arrow_menu <title> <option1> <option2> ...
  # Returns selected index (0-based) in $MENU_RESULT
  local title="$1"; shift
  local options=("$@")
  local count=${#options[@]}
  local selected=0

  # hide cursor
  tput civis 2>/dev/null || true
  trap 'tput cnorm 2>/dev/null || true' EXIT INT TERM

  while true; do
    # draw choices
    echo -e "  ${BOLD}${YELLOW}${title}${RESET}\n"
    for i in "${!options[@]}"; do
      if [[ $i -eq $selected ]]; then
        echo -e "   ${ACCENT}${BOLD}▶  ${options[$i]}${RESET}"
      else
        echo -e "   ${DIM}   ${options[$i]}${RESET}"
      fi
    done
    echo -e "\n  ${DIM}↑/↓ navigate  •  Enter select  •  q quit${RESET}"

    read_key
    case "$READ_KEY_RESULT" in
      up|k)    [[ $selected -gt 0 ]] && (( selected-- )) || true ;;
      down|j)  [[ $selected -lt $((count - 1)) ]] && (( selected++ )) || true ;;
      enter)   break ;;
      q|Q)     tput cnorm 2>/dev/null || true; echo; exit 0 ;;
    esac

    # move cursor back up to redraw
    local lines=$(( count + 4 ))
    tput cuu "$lines" 2>/dev/null || printf '\033[%dA' "$lines"
  done

  tput cnorm 2>/dev/null || true
  MENU_RESULT=$selected
}

file_picker() {
  # file_picker <title> [decrypt]
  # Lists regular files in cwd for arrow-key selection.
  # If second arg is "decrypt", prefer .enc files (fall back to all with warning).
  # Result stored in $FILE_PICK_RESULT.
  local title="$1"
  local filter_mode="${2:-}"
  local max_visible=12
  local files=()
  local display_names=()
  local warning=""

  if [[ "$filter_mode" == "decrypt" ]]; then
    # Try .enc files first
    while IFS= read -r -d '' f; do
      files+=("$f")
      display_names+=("🔒  ${f##*/}")
    done < <(find . -maxdepth 1 -type f -name '*.enc' -print0 | sort -z)

    if [[ ${#files[@]} -eq 0 ]]; then
      # No .enc files — fall back to all files with warning
      warning="  ${YELLOW}⚠ No .enc files found — showing all files${RESET}"
      while IFS= read -r -d '' f; do
        files+=("$f")
        display_names+=("📄  ${f##*/}")
      done < <(find . -maxdepth 1 -type f -not -name '.*' -print0 | sort -z)
    fi
  else
    while IFS= read -r -d '' f; do
      files+=("$f")
      display_names+=("📄  ${f##*/}")
    done < <(find . -maxdepth 1 -type f -not -name '.*' -print0 | sort -z)
  fi

  if [[ ${#files[@]} -eq 0 ]]; then
    echo -e "  ${RED}✗ No files found in $(pwd)${RESET}"
    FILE_PICK_RESULT=""
    return 1
  fi

  local count=${#files[@]}
  local selected=0
  local scroll=0
  local drawn_lines=0

  tput civis 2>/dev/null || true
  trap 'tput cnorm 2>/dev/null || true' EXIT INT TERM

  while true; do
    local visible=$count
    [[ $visible -gt $max_visible ]] && visible=$max_visible || true

    # keep selected in view
    if [[ $selected -lt $scroll ]]; then
      scroll=$selected
    elif [[ $selected -ge $((scroll + visible)) ]]; then
      scroll=$(( selected - visible + 1 ))
    fi

    # build frame
    local buf=""
    buf+="  ${BOLD}${YELLOW}${title}${RESET}"$'\n'
    buf+="  ${DIM}$(pwd)${RESET}"$'\n'
    if [[ -n "$warning" ]]; then
      buf+="${warning}"$'\n'
    fi

    if [[ $scroll -gt 0 ]]; then
      buf+="   ${DIM}  ↑ more${RESET}"$'\n'
    else
      buf+="  "$'\n'
    fi

    local i
    for (( i = scroll; i < scroll + visible && i < count; i++ )); do
      if [[ $i -eq $selected ]]; then
        buf+="   ${ACCENT}${BOLD}▶  ${display_names[$i]}${RESET}"$'\n'
      else
        buf+="   ${DIM}   ${display_names[$i]}${RESET}"$'\n'
      fi
    done

    if [[ $(( scroll + visible )) -lt $count ]]; then
      buf+="   ${DIM}  ↓ more${RESET}"$'\n'
    else
      buf+="  "$'\n'
    fi
    buf+="  ${DIM}↑/↓ navigate  •  Enter select  •  q quit${RESET}"$'\n'

    # erase previous frame
    if [[ $drawn_lines -gt 0 ]]; then
      tput cuu "$drawn_lines" 2>/dev/null || printf '\033[%dA' "$drawn_lines"
      tput ed 2>/dev/null || true
    fi
    echo -e "$buf"
    local warning_lines=0
    [[ -n "$warning" ]] && warning_lines=1
    drawn_lines=$(( 3 + warning_lines + visible + 1 + 1 ))

    read_key
    case "$READ_KEY_RESULT" in
      up|k)    [[ $selected -gt 0 ]] && (( selected-- )) || true ;;
      down|j)  [[ $selected -lt $((count - 1)) ]] && (( selected++ )) || true ;;
      enter)   break ;;
      q|Q)     tput cnorm 2>/dev/null || true; echo; exit 0 ;;
    esac
  done

  tput cnorm 2>/dev/null || true
  FILE_PICK_RESULT="${files[$selected]}"
}

# ── F8: password never on argv ────────────────────────────────
# _pw_run CMD... — runs CMD with the password supplied via `-pass stdin`
# (manual mode: piped from the in-memory variable by a builtin printf, so the
# secret never appears in any process's argv/environment) or via
# `-pass file:PATH` (file mode: only the path lands on argv, never contents).
_pw_run() {
  if [[ "${PASS_MODE:-0}" -eq 0 ]]; then
    printf '%s\n' "$PASSWORD" | "$@" -pass stdin
  else
    "$@" -pass "file:${PASS_FILE}"
  fi
}

# ── F8: HMAC-SHA256 without any key material on argv ────────────
# RFC 2104 construction assembled from plain pipes:
#   HMAC = H( (K ^ opad) || H( (K ^ ipad) || m ) )
# K (32B, PBKDF2-derived) is padded to the 64-byte SHA-256 block, XORed with
# 0x36/0x5c into printf FORMAT strings (text escapes like '\046' — the raw
# key bytes never become shell variables, argv, or environment), then piped
# as data prefixes into `openssl dgst`. Verified in the test suite against
# `openssl dgst -mac HMAC` ground truth.

# _block_fmt <key-hex> <xor-byte> -> octal printf-escape string (64 bytes)
_block_fmt() {
  local k="$1" xor="$2" out="" i b
  # pad key (32B -> 64B) with zero bytes: 64 zero hex chars
  k="${k}$(printf '00%.0s' {1..32})"
  for (( i = 0; i < 128; i += 2 )); do
    b=$(( 16#${k:i:2} ))
    out+="\\$(printf '%03o' $(( b ^ xor )))"
  done
  printf '%s' "$out"
}

# hmac_sha256 <key-hex>  — reads the message from stdin, prints lowercase hex
hmac_sha256() {
  local ipad opad
  ipad="$(_block_fmt "$1" 0x36)"
  opad="$(_block_fmt "$1" 0x5c)"
  {
    printf "$opad"
    { printf "$ipad"; cat; } | openssl dgst -sha256 -binary
  } | openssl dgst -sha256 | sed 's/^.*= *//' | tr 'A-F' 'a-f'
}

# _derive_mac_key <macsalt-hex> <iter> — PBKDF2(password, macsalt, iter)[0:32]
# via `openssl enc -P` (password from stdin/file — never argv). Prints hex.
_derive_mac_key() {
  local macsalt="$1" iter="$2" key
  if [[ "${PASS_MODE:-0}" -eq 0 ]]; then
    key="$(printf '%s\n' "$PASSWORD" | openssl enc -aes-256-cbc -pbkdf2 -iter "$iter" \
      -salt -S "$macsalt" -P -pass stdin | sed -n 's/^key=//p' | tr -d '\r' | tr 'A-F' 'a-f')"
  else
    key="$(openssl enc -aes-256-cbc -pbkdf2 -iter "$iter" \
      -salt -S "$macsalt" -P -pass "file:${PASS_FILE}" | sed -n 's/^key=//p' | tr -d '\r' | tr 'A-F' 'a-f')"
  fi
  if [[ ! "$key" =~ ^[0-9a-f]{64}$ ]]; then
    echo -e "  ${RED}✗ Key derivation failed${RESET}" >&2
    return 1
  fi
  printf '%s' "$key"
}

# ── F8: file modes (temp files are 0600; keep the old openssl-style mode) ──
_default_mode() {
  local m
  m="$(umask)"
  printf '%o' $(( 0666 & ~0$m ))
}
_mode_of() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1" 2>/dev/null || _default_mode
  fi
}

# ── step 1: mode ─────────────────────────────────────────────
header
arrow_menu "What would you like to do?" \
  "🔒  Encrypt a file" \
  "🔓  Decrypt a file"
MODE=$MENU_RESULT   # 0=encrypt  1=decrypt

# ── step 2: select input file ────────────────────────────────
header
[[ $MODE -eq 0 ]] && echo -e "  Mode: ${GREEN}${BOLD}ENCRYPT${RESET}\n" \
                   || echo -e "  Mode: ${YELLOW}${BOLD}DECRYPT${RESET}\n"

if [[ $MODE -eq 0 ]]; then
  file_picker "Select file to encrypt"
else
  file_picker "Select file to decrypt" "decrypt"
fi
INPUT_FILE="$FILE_PICK_RESULT"

# ── step 3: determine output file ────────────────────────────
header
[[ $MODE -eq 0 ]] && echo -e "  Mode: ${GREEN}${BOLD}ENCRYPT${RESET}\n" \
                   || echo -e "  Mode: ${YELLOW}${BOLD}DECRYPT${RESET}\n"
echo -e "  Input:  ${DIM}${INPUT_FILE}${RESET}\n"

if [[ $MODE -eq 0 ]]; then
  OUTPUT_FILE="${INPUT_FILE}.enc"
else
  if [[ "$INPUT_FILE" == *.enc ]]; then
    OUTPUT_FILE="${INPUT_FILE%.enc}"
  else
    echo -en "  ${BOLD}Output file name:${RESET} "
    read -r OUTPUT_FILE
  fi
fi

# ── handle output file conflict ──────────────────────────────
# Note (F8): choosing "replace" no longer risks the original — the decrypt
# runs into a temp file and is only renamed over the target on SUCCESS.
if [[ -e "$OUTPUT_FILE" ]]; then
  header
  [[ $MODE -eq 0 ]] && echo -e "  Mode: ${GREEN}${BOLD}ENCRYPT${RESET}\n" \
                     || echo -e "  Mode: ${YELLOW}${BOLD}DECRYPT${RESET}\n"
  echo -e "  Input:  ${DIM}${INPUT_FILE}${RESET}"
  echo -e "  Output: ${DIM}${OUTPUT_FILE}${RESET}\n"
  echo -e "  ${YELLOW}⚠ File already exists:${RESET} ${DIM}${OUTPUT_FILE}${RESET}\n"
  arrow_menu "What would you like to do?" \
    "♻️   Replace existing file" \
    "✏️   Rename output file" \
    "✗  Cancel"
  CONFLICT=$MENU_RESULT   # 0=replace  1=rename  2=cancel

  if [[ $CONFLICT -eq 2 ]]; then
    echo -e "\n  ${DIM}Cancelled.${RESET}\n"
    exit 0
  elif [[ $CONFLICT -eq 1 ]]; then
    header
    [[ $MODE -eq 0 ]] && echo -e "  Mode: ${GREEN}${BOLD}ENCRYPT${RESET}\n" \
                       || echo -e "  Mode: ${YELLOW}${BOLD}DECRYPT${RESET}\n"
    echo -e "  Input:  ${DIM}${INPUT_FILE}${RESET}\n"
    echo -en "  ${BOLD}New output file name:${RESET} "
    read -r OUTPUT_FILE
  fi
  # CONFLICT==0 (replace): OUTPUT_FILE kept — replaced only after success (F8)
fi

# ── step 4: password source ──────────────────────────────────
header
[[ $MODE -eq 0 ]] && echo -e "  Mode: ${GREEN}${BOLD}ENCRYPT${RESET}\n" \
                   || echo -e "  Mode: ${YELLOW}${BOLD}DECRYPT${RESET}\n"
echo -e "  Input:  ${DIM}${INPUT_FILE}${RESET}"
echo -e "  Output: ${DIM}${OUTPUT_FILE}${RESET}\n"
arrow_menu "How would you like to supply the password?" \
  "⌨️   Type password manually" \
  "📄  Load password from a file"
PASS_MODE=$MENU_RESULT   # 0=manual  1=file

header
[[ $MODE -eq 0 ]] && echo -e "  Mode: ${GREEN}${BOLD}ENCRYPT${RESET}\n" \
                   || echo -e "  Mode: ${YELLOW}${BOLD}DECRYPT${RESET}\n"
echo -e "  Input:  ${DIM}${INPUT_FILE}${RESET}"
echo -e "  Output: ${DIM}${OUTPUT_FILE}${RESET}\n"

# ── step 5: collect password ─────────────────────────────────
if [[ $PASS_MODE -eq 0 ]]; then
  while true; do
    echo -en "  ${BOLD}Password:${RESET} "
    read -rs PASSWORD; echo
    if [[ $MODE -eq 0 ]]; then
      echo -en "  ${BOLD}Confirm  :${RESET} "
      read -rs CONFIRM; echo
      [[ "$PASSWORD" == "$CONFIRM" ]] && break
      echo -e "  ${RED}✗ Passwords do not match. Try again.${RESET}\n"
    else
      break
    fi
  done
else
  header
  [[ $MODE -eq 0 ]] && echo -e "  Mode: ${GREEN}${BOLD}ENCRYPT${RESET}\n" \
                     || echo -e "  Mode: ${YELLOW}${BOLD}DECRYPT${RESET}\n"
  echo -e "  Input:  ${DIM}${INPUT_FILE}${RESET}"
  echo -e "  Output: ${DIM}${OUTPUT_FILE}${RESET}\n"
  file_picker "Select password file"
  PASS_FILE="$FILE_PICK_RESULT"
fi

# ── step 6: run openssl (F8: temps + atomic rename + MAC) ─────
echo
echo -e "  ${DIM}Working…${RESET}"

# Temp files live NEXT TO the output so the final mv is an atomic rename on
# the same filesystem. Replace the menus' cursor trap with cleanup of ours.
OUT_DIR="$(dirname -- "$OUTPUT_FILE")"
TMP_OUT="$(mktemp "$OUT_DIR/.crypt-out.XXXXXX")"
TMP_BODY="$(mktemp "$OUT_DIR/.crypt-body.XXXXXX")"
trap '_cleanup_temps' EXIT
trap '_cleanup_temps; exit 129' HUP
trap '_cleanup_temps; exit 130' INT
trap '_cleanup_temps; exit 143' TERM

_finalize() {
  # $1 = existing-mode source (optional): preserve it; else umask default.
  local mode
  if [[ -e "$OUTPUT_FILE" ]]; then
    mode="$(_mode_of "$OUTPUT_FILE")"
  else
    mode="$(_default_mode)"
  fi
  chmod "$mode" "$TMP_OUT" 2>/dev/null || true
  mv -f "$TMP_OUT" "$OUTPUT_FILE"
  TMP_OUT=""
}

if [[ $MODE -eq 0 ]]; then
  # ── ENCRYPT: always the new authenticated format ──────────────
  MACSALT="$(openssl rand -hex 8)"
  LINE1="${MAGIC} ${ITER} ${MACSALT}"

  # Body: AES-256-CTR, PBKDF2 (openssl derives key/IV internally from the
  # password + embedded random salt; password fed via stdin / file:).
  _pw_run openssl enc -aes-256-ctr -pbkdf2 -iter "$ITER" -salt \
    -in "$INPUT_FILE" -out "$TMP_BODY"

  # MAC over (header line || ciphertext); MAC key is purpose-separated
  # (different PBKDF2 salt) from the encryption key.
  MACKEY="$(_derive_mac_key "$MACSALT" "$ITER")"
  HMAC="$( { printf '%s\n' "$LINE1"; cat "$TMP_BODY"; } | hmac_sha256 "$MACKEY")"
  if [[ ! "$HMAC" =~ ^[0-9a-f]{64}$ ]]; then
    echo -e "  ${RED}✗ HMAC computation failed — nothing written${RESET}\n"
    exit 1
  fi

  { printf '%s\n' "$LINE1"; printf '%s\n' "$HMAC"; cat "$TMP_BODY"; } > "$TMP_OUT"
  _finalize
  echo -e "  ${GREEN}${BOLD}✔ Encrypted (authenticated):${RESET} $OUTPUT_FILE"
else
  # ── DECRYPT: detect format, verify MAC first, temp + rename ────
  HEAD9="$(head -c 9 -- "$INPUT_FILE" || true)"
  HEAD8="${HEAD9:0:8}"
  if [[ "$HEAD9" == "${MAGIC}" ]]; then
    # v2: ONEGYENC2 <iter> <macsalt>\n<hmac>\n<openssl-body>
    IFS= read -r LINE1 < "$INPUT_FILE" || true
    IFS= read -r STORED_HMAC < <(sed -n '2p' "$INPUT_FILE") || true
    read -r _ M2_ITER M2_MACSALT _extra <<< "$LINE1" || true

    if [[ ! "$M2_ITER" =~ ^[0-9]{4,10}$ ]] || [[ ! "$M2_MACSALT" =~ ^[0-9a-fA-F]{16}$ ]] \
       || [[ ! "$STORED_HMAC" =~ ^[0-9a-fA-F]{64}$ ]]; then
      echo -e "  ${RED}✗ Corrupt header — nothing written${RESET}\n"
      exit 1
    fi
    # Byte offset of the openssl body: len(line1)+1 + len(line2)+1
    BODY_OFF=$(( ${#LINE1} + 1 + ${#STORED_HMAC} + 1 ))

    # 1) Verify HMAC BEFORE decrypting anything (encrypt-then-MAC).
    MACKEY="$(_derive_mac_key "$M2_MACSALT" "$M2_ITER")"
    COMPUTED="$( { printf '%s\n' "$LINE1"; tail -c "+$((BODY_OFF + 1))" -- "$INPUT_FILE"; } | hmac_sha256 "$MACKEY")"
    if [[ "${COMPUTED}" != "$(printf '%s' "$STORED_HMAC" | tr 'A-F' 'a-f')" ]]; then
      echo -e "  ${RED}✗ HMAC verification FAILED — wrong password or tampered file.${RESET}"
      echo -e "  ${DIM}  Nothing was written; your existing files are untouched.${RESET}\n"
      exit 1
    fi

    # 2) MAC good → decrypt the body into the temp file.
    if ! _pw_run openssl enc -d -aes-256-ctr -pbkdf2 -iter "$M2_ITER" \
        -in <(tail -c "+$((BODY_OFF + 1))" -- "$INPUT_FILE") -out "$TMP_OUT"; then
      echo -e "  ${RED}✗ Decryption failed — nothing written${RESET}\n"
      exit 1
    fi
    _finalize
    echo -e "  ${GREEN}${BOLD}✔ Decrypted (HMAC verified):${RESET} $OUTPUT_FILE"
  elif [[ "$HEAD8" == "Salted__" ]]; then
    # Legacy blob written by the OLD version of this script: raw openssl
    # AES-256-CBC + PBKDF2, no MAC. Still decryptable (backwards
    # compatible), written via temp+rename so a bad password can no longer
    # destroy the destination — but it CANNOT be authenticated.
    echo -e "  ${YELLOW}⚠ Legacy format detected (unauthenticated AES-CBC).${RESET}"
    echo -e "  ${DIM}  Integrity cannot be verified; re-encrypt after this decrypt to upgrade.${RESET}"
    if ! _pw_run openssl enc -d -aes-256-cbc -pbkdf2 -iter "$LEGACY_ITER" \
        -in "$INPUT_FILE" -out "$TMP_OUT"; then
      echo -e "  ${RED}✗ Decryption failed (wrong password?) — nothing written${RESET}"
      echo -e "  ${DIM}  The original file is untouched.${RESET}\n"
      exit 1
    fi
    _finalize
    echo -e "  ${GREEN}${BOLD}✔ Decrypted (legacy):${RESET} $OUTPUT_FILE"
  else
    echo -e "  ${RED}✗ Unrecognized file format (expected ${MAGIC} header or Salted__ legacy blob)${RESET}\n"
    exit 1
  fi
fi

echo
