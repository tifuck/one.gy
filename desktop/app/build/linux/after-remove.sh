#!/bin/bash

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
# ONE.GY: drop the update timer on uninstall only (deb: remove/purge, rpm: 0),
# not when an upgrade runs this script.
case "$1" in
  remove|purge|0)
    if [ -d /run/systemd/system ]; then
      systemctl disable --now onegy-desktop-update.timer || true
    fi
    rm -f /etc/systemd/system/onegy-desktop-update.service /etc/systemd/system/onegy-desktop-update.timer
    rm -f /etc/polkit-1/rules.d/49-onegy-desktop-update.rules
    if [ "$(readlink /usr/bin/onegy)" = '/opt/${sanitizedProductName}/resources/engine/onegy' ]; then
      rm -f /usr/bin/onegy
    fi
    if [ -d /run/systemd/system ]; then
      systemctl daemon-reload || true
    fi
    # The Dolphin overlay plugin from after-install.sh, wherever it went.
    {
      for tool in qtpaths qtpaths6 qtpaths-qt5 qtpaths-qt6 qmake qmake6 qmake-qt5 qmake-qt6; do
        command -v "$tool" > /dev/null 2>&1 || continue
        case "$tool" in
          qtpaths*) "$tool" --query QT_INSTALL_PLUGINS 2>/dev/null ;;
          *) "$tool" -query QT_INSTALL_PLUGINS 2>/dev/null ;;
        esac
      done
      printf '%s\n' /usr/lib/x86_64-linux-gnu/qt5/plugins /usr/lib64/qt5/plugins /usr/lib/qt5/plugins /usr/lib/qt/plugins \
        /usr/lib/x86_64-linux-gnu/qt6/plugins /usr/lib64/qt6/plugins /usr/lib/qt6/plugins
    } | while read -r dir; do
      for kf in kf5 kf6; do
        if [ -n "$dir" ] && [ -f "$dir/$kf/overlayicon/onegy-overlay.so" ]; then
          rm -f "$dir/$kf/overlayicon/onegy-overlay.so"
          rmdir "$dir/$kf/overlayicon" 2>/dev/null || true
        fi
      done
    done
    ;;
esac
