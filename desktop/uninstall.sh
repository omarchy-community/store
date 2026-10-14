#!/bin/bash
# Removes the Omarchy Store from this computer and puts back everything it changed.
#
#   omarchy-store --uninstall            remove the store, keep apps installed through it
#   omarchy-store --uninstall --all      also remove SnapDock, Lifeboat, the Omarchy Store screensaver
#                                        and theme, and switch back to the default Omarchy theme
#
# Everything in your home folder that isn't the store's own is left alone.
set -u
# Run from a copy so deleting the store folder mid-way can't cut this script short.
if [ "${OMARCHY_STORE_UNINSTALL_COPY:-}" != 1 ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  cp "${BASH_SOURCE[0]}" /tmp/omarchy-store-uninstall.$$ && OMARCHY_STORE_UNINSTALL_COPY=1 exec bash /tmp/omarchy-store-uninstall.$$ "$@"
fi
ALL=0; for a in "$@"; do [ "$a" = "--all" ] && ALL=1; done
DEST="$HOME/.local/share/omarchy-store"
say() { printf '\033[1m%s\033[0m\n' "$*"; }

say "Removing the Omarchy Store…"
echo "Enter your password to confirm (this also lets the store remove its system packages):"
if ! sudo -v; then echo; say "Cancelled — nothing was removed."; exit 1; fi
echo

# 1. Stop the helper and any store window (classic helper, Electron build, AppImage, old webapp).
pkill -f "$DEST/omarchy-store --serve" 2>/dev/null || true
pkill -f "omarchy-store --serve" 2>/dev/null || true
pkill -f "omarchy-store-electron.AppImage" 2>/dev/null || true
pkill -f "linux-unpacked/omarchy-store" 2>/dev/null || true
pkill -f "Omarchy Store.*AppImage" 2>/dev/null || true
pkill -f "app=.*omarchy-store" 2>/dev/null || true
[ -n "${OMARCHY_STORE_PID:-}" ] && kill "$OMARCHY_STORE_PID" 2>/dev/null || true
sleep 1

# 2. Hooks the store installed (post-update validation).
for d in "$HOME/.config/omarchy/hooks/post-update.d" "$HOME/.config/omarchy/hooks"; do
  rm -f "$d"/omarchy-store-* "$d"/post-update-validation.sh 2>/dev/null
done
if command -v omarchy-hook-remove >/dev/null 2>&1; then omarchy-hook-remove post-update post-update-validation.sh 2>/dev/null || true; fi

# 3. Launcher entries, icons, binaries, the old webapp, the Electron AppImage.
rm -f "$HOME/.local/bin/omarchy-store" \
      "$HOME/.local/share/applications/omarchy-store.desktop" \
      "$HOME/.local/share/applications/Omarchy Store.desktop" \
      "$HOME/.local/share/applications/omarchy-store-electron.desktop" \
      "$HOME/.local/share/icons/hicolor/scalable/apps/omarchy-store.svg" \
      "$HOME"/.local/share/icons/hicolor/{48x48,128x128,256x256,512x512}/apps/omarchy-store.png \
      "$HOME/omarchy-store-electron.AppImage" "$HOME/omarchy-store-electron.AppImage.part" \
      "$HOME/.local/share/omarchy-store-electron/"*.AppImage 2>/dev/null
rm -rf "$HOME/.local/share/omarchy-store-electron" "$HOME/.config/Omarchy Store" "$HOME/.config/omarchy-store-electron" 2>/dev/null
# Old webapp (Chromium --app profile) if one was made by an earlier version.
rm -rf "$HOME/.local/share/omarchy/webapps/omarchy-store" "$HOME/.local/share/applications/omarchy-store-webapp.desktop" 2>/dev/null
command -v omarchy-webapp-remove >/dev/null 2>&1 && omarchy-webapp-remove "Omarchy Store" >/dev/null 2>&1 || true

# 4. State, cache and the app itself (including an Electron build's own copy of the store files).
rm -rf "$HOME/.local/state/omarchy-store" "$HOME/.cache/omarchy-store" "$DEST" "$HOME/.local/share/omarchy-store-overlay"
if [ -n "${OMARCHY_STORE_HOME:-}" ] && [ "$OMARCHY_STORE_HOME" != "$DEST" ] && [ -d "$OMARCHY_STORE_HOME" ]; then
  case "$OMARCHY_STORE_HOME" in
    "$HOME"/*) rm -rf "$OMARCHY_STORE_HOME/site" "$OMARCHY_STORE_HOME/omarchy-store" "$OMARCHY_STORE_HOME/uninstall.sh" 2>/dev/null ;;
  esac
fi
rm -rf "$HOME/.config/Omarchy Store" "$HOME/.cache/Omarchy Store" "$HOME/.local/share/Omarchy Store" 2>/dev/null
rm -f "$HOME/.local/share/applications/omarchy-store-electron.desktop" "$HOME/.local/share/applications/appimagekit-omarchy-store.desktop" 2>/dev/null
update-desktop-database "$HOME/.local/share/applications" &>/dev/null || true

# 5. The system package, if the store was installed with pacman/AUR (needs your password).
SP=""
for p in omarchy-store omarchy-store-bin omarchy-store-electron; do pacman -Qq "$p" >/dev/null 2>&1 && SP="$SP $p"; done
if [ -n "$SP" ]; then
  echo; say "Removing the Omarchy Store system package ($SP) — enter your password:"
  sudo pacman -Rns --noconfirm $SP || true
fi

if [ "$ALL" = 1 ]; then
  echo
  say "Removing the apps that came with the store and putting your desktop back…"
  # SnapDock restores the dock/keys/title bars it changed, then its package goes.
  if command -v snapdock >/dev/null 2>&1; then snapdock uninstall </dev/null || true; fi
  # Theme: switch back to Omarchy's default before deleting the store theme.
  if [ "$(cat "$HOME/.local/state/omarchy/current/theme.name" 2>/dev/null)" = "store" ] || [ "$(cat "$HOME/.config/omarchy/current/theme.name" 2>/dev/null)" = "store" ]; then
    command -v omarchy-theme-set >/dev/null 2>&1 && omarchy-theme-set tokyo-night >/dev/null 2>&1 || true
  fi
  rm -rf "$HOME/.config/omarchy/themes/store" "$HOME/.config/omarchy/themes/omarchy-store" 2>/dev/null
  # Screensaver plugin.
  command -v omarchy >/dev/null 2>&1 && omarchy plugin remove omarchy-store-screensaver >/dev/null 2>&1 || true
  rm -rf "$HOME/.config/omarchy/plugins/omarchy-store-screensaver" 2>/dev/null
  # Packages (needs your password).
  PK=""
  for p in snapdock lifeboat omarchy-browser omarchy-store-screensaver; do pacman -Qq "$p" >/dev/null 2>&1 && PK="$PK $p"; done
  if [ -n "$PK" ]; then echo; sudo pacman -Rns --noconfirm $PK || true; fi
  command -v hyprctl >/dev/null 2>&1 && hyprctl reload >/dev/null 2>&1 || true
  echo
  say "Omarchy Store and its apps are removed. Your desktop is back to Omarchy's defaults."
else
  echo
  say "Omarchy Store removed. Apps you installed with it are still installed."
  echo "To also remove SnapDock, Lifeboat, the screensaver and the theme: omarchy-store --uninstall --all"
fi
