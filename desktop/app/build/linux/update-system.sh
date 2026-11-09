#!/bin/bash
# Installs the latest stable ONE.GY Desktop .deb / .rpm when it is newer than
# the installed one. Run as root by onegy-desktop-update.timer (written by
# after-install.sh); the running app relaunches itself once its files change.
# The download is checked against the sha512 in the release's latest-linux.yml.
set -euo pipefail

FEED=https://github.com/tifuck/one.gy/releases/latest/download
here="$(dirname "$(readlink -f "$0")")"
kind="$(cat "$here/package-type")"

case "$kind" in
  deb) file=onegy-desktop_amd64.deb; current="$(dpkg-query -W -f='${Version}' onegy-desktop)" ;;
  rpm) file=onegy-desktop.x86_64.rpm; current="$(rpm -q --qf '%{VERSION}' onegy-desktop)" ;;
  *) echo "[UPDATE] unknown package type: $kind"; exit 1 ;;
esac

yml="$(curl -fsSL --max-time 60 "$FEED/latest-linux.yml")"
latest="$(sed -n "s/^version: *['\"]\{0,1\}\([^'\"]*\).*/\1/p" <<<"$yml" | head -n1)"
sha="$(awk -v f="$file" '$1 == "-" && $2 == "url:" { hit = ($3 == f) } hit && $1 == "sha512:" { print $2; exit }' <<<"$yml")"

# Stable releases only (no pre-release suffix), and never a downgrade.
if ! [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [ -z "$sha" ]; then
  echo "[UPDATE] no usable release in latest-linux.yml"
  exit 1
fi
if [ "$latest" = "$current" ] || [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -n1)" != "$latest" ]; then
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
chmod 755 "$tmp"
pkg="$tmp/$file"
echo "[UPDATE] installing $latest (installed: $current)"
curl -fsSL --max-time 1800 -o "$pkg" "$FEED/$file"
chmod 644 "$pkg"
want="$(base64 -d <<<"$sha" | od -An -tx1 -v | tr -d ' \n')"
got="$(sha512sum "$pkg" | cut -d' ' -f1)"
if [ "$want" != "$got" ]; then
  echo "[UPDATE] sha512 mismatch for $file, not installing"
  exit 1
fi

if [ "$kind" = deb ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg"
elif command -v dnf >/dev/null 2>&1; then
  dnf -y install "$pkg"
elif command -v zypper >/dev/null 2>&1; then
  zypper --non-interactive install --allow-unsigned-rpm "$pkg"
else
  rpm -U "$pkg"
fi
echo "[UPDATE] installed $latest"
