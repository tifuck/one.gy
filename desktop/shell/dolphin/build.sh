#!/bin/bash
# Builds the Dolphin overlay plugin (README.md) into
# desktop/app/resources/dolphin/kf5|kf6/onegy-overlay.so, where
# electron-builder ships it (linux extraResources) and the deb / rpm
# after-install.sh installs it into the system's Qt plugin dirs.
#   bash build.sh                        both, each in its container (docker or podman)
#   bash build.sh kf6                    one of them
#   bash build.sh --here kf5 [out_dir]   with this machine's Qt / KF dev packages
# Each container is the oldest base its build should load on: Qt refuses a
# plugin built against a newer Qt minor version than Dolphin runs on. KF5:
# Ubuntu 22.04 (Qt 5.15, KF 5.92); KF6: Debian 13 (Qt 6.8, KF 6.13).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../app/resources/dolphin"

if [ "${1:-}" = --here ]; then
  kf="${2:?kf5 or kf6}"
  dest="${3:-$out}"
  build="$(mktemp -d)"
  trap 'rm -rf "$build"' EXIT
  cmake -S "$here" -B "$build" -DKF="${kf#kf}" -DCMAKE_BUILD_TYPE=Release -DCMAKE_MODULE_LINKER_FLAGS=-s
  cmake --build "$build" -j"$(nproc)"
  install -D -m 644 "$build/onegy-overlay.so" "$dest/$kf/onegy-overlay.so"
  echo "built $dest/$kf/onegy-overlay.so"
  exit 0
fi

engine="$(command -v docker || command -v podman || true)"
[ -n "$engine" ] || { echo "build.sh: docker or podman needed (or --here)" >&2; exit 1; }

targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(kf5 kf6)
mkdir -p "$out"
# docker writes as root; rootless podman already writes as this user.
own=true
[ "$(basename "$engine")" != docker ] || own="chown -R $(id -u):$(id -g)"
for kf in "${targets[@]}"; do
  case "$kf" in
    kf5) image=ubuntu:22.04; pkgs="cmake make g++ qtbase5-dev libkf5kio-dev" ;;
    kf6) image=debian:trixie; pkgs="cmake make g++ qt6-base-dev libkf6kio-dev" ;;
    *) echo "build.sh: unknown target $kf" >&2; exit 1 ;;
  esac
  "$engine" run --rm -v "$here:/src:ro" -v "$out:/out" -e DEBIAN_FRONTEND=noninteractive "$image" bash -c "
    apt-get update -qq && apt-get install -y -qq --no-install-recommends $pkgs > /dev/null &&
    bash /src/build.sh --here $kf /out && $own /out/$kf"
done
