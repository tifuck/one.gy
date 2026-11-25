#!/bin/bash

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
#
# Those apparmor_parser flags are akin to performing a dry run of loading a profile.
# https://wiki.debian.org/AppArmor/HowToUse#Dumping_profiles
#
# Unfortunately, at the moment AppArmor doesn't have a good story for backwards compatibility.
# https://askubuntu.com/questions/1517272/writing-a-backwards-compatible-apparmor-profile
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    # Use cases are for example environments where images for clients are maintained.
    # There, AppArmor might correctly be installed, but live updating makes no sense.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      # Extra flags taken from dh_apparmor:
      # > By using '-W -T' we ensure that any abstraction updates are also pulled in.
      # https://wiki.debian.org/AppArmor/Contribute/FirstTimeProfileImport
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# ONE.GY: the bundled onegy binary (CLI + sync engine) on PATH. Never
# replaces an onegy that is not this package's.
ONEGY_BIN='/opt/${sanitizedProductName}/resources/engine/onegy'
if [ ! -e /usr/bin/onegy ] || [ "$(readlink /usr/bin/onegy)" = "$ONEGY_BIN" ]; then
  ln -sfn "$ONEGY_BIN" /usr/bin/onegy
fi

# ONE.GY: install updates in the background, no password prompt. A root timer
# runs resources/update-system.sh (removed again by after-remove.sh).
if [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/onegy-desktop-update.service <<'EOF'
[Unit]
Description=Install ONE.GY Desktop updates
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash "/opt/${sanitizedProductName}/resources/update-system.sh"
EOF
  cat > /etc/systemd/system/onegy-desktop-update.timer <<'EOF'
[Unit]
Description=Check for ONE.GY Desktop updates

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload || true
  systemctl enable --now onegy-desktop-update.timer || true
fi

# ONE.GY: "Update and restart" in the app starts the same service. This rule
# lets a user signed in at this computer start just that unit without a
# password (it can only install the latest release, sha512-checked); polkit
# without rules.d (older Debian/Ubuntu) asks for the password instead.
if [ -d /etc/polkit-1/rules.d ]; then
  cat > /etc/polkit-1/rules.d/49-onegy-desktop-update.rules <<'EOF'
polkit.addRule(function (action, subject) {
  if (action.id === "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") === "onegy-desktop-update.service" &&
      action.lookup("verb") === "start" &&
      subject.local && subject.active) {
    return polkit.Result.YES;
  }
});
EOF
  chmod 644 /etc/polkit-1/rules.d/49-onegy-desktop-update.rules
fi

# ONE.GY: Dolphin's sync status overlays (desktop/shell/dolphin): the KF5 and
# KF6 builds into <Qt plugin dir>/kf5|kf6/overlayicon of each Qt 5 / Qt 6
# found here (removed again by after-remove.sh). Without Qt's own tools (no
# dev packages), the first usual dir that has KDE plugins (kf5/, kf6/). Renamed
# into place: a running Dolphin keeps the old file mapped. Never fails the
# install.
onegy_qt_plugin_dirs() {
  found=
  for tool in qtpaths qtpaths6 qtpaths-qt5 qtpaths-qt6 qmake qmake6 qmake-qt5 qmake-qt6; do
    command -v "$tool" > /dev/null 2>&1 || continue
    case "$tool" in
      qtpaths*) q=--query ;;
      *) q=-query ;;
    esac
    major="$("$tool" $q QT_VERSION 2>/dev/null | cut -d. -f1)"
    case "$major" in
      5|6) echo "$major $("$tool" $q QT_INSTALL_PLUGINS 2>/dev/null)"; found="$found $major" ;;
    esac
  done
  for fallback in "5 /usr/lib/x86_64-linux-gnu/qt5/plugins" "5 /usr/lib64/qt5/plugins" "5 /usr/lib/qt5/plugins" \
    "5 /usr/lib/qt/plugins" "6 /usr/lib/x86_64-linux-gnu/qt6/plugins" "6 /usr/lib64/qt6/plugins" "6 /usr/lib/qt6/plugins"; do
    read -r major dir <<< "$fallback"
    case "$found" in *"$major"*) continue ;; esac
    if [ -d "$dir/kf$major" ]; then
      echo "$fallback"
      found="$found $major"
    fi
  done
}
ONEGY_DOLPHIN='/opt/${sanitizedProductName}/resources/dolphin'
onegy_qt_plugin_dirs | sort -u | while read -r major dir; do
  case "$major" in 5|6) ;; *) continue ;; esac
  so="$ONEGY_DOLPHIN/kf$major/onegy-overlay.so"
  [ -n "$dir" ] && [ -d "$dir" ] && [ -f "$so" ] || continue
  to="$dir/kf$major/overlayicon"
  { install -D -m 644 "$so" "$to/.onegy-overlay.so.new" && mv -f "$to/.onegy-overlay.so.new" "$to/onegy-overlay.so"; } || true
done
