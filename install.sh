#!/bin/sh
# Install the extension for the current user.
set -e
UUID=muslimtify@abdulazizumarovich.github.io
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
rm -rf "$DEST"   # drop stale files from previous versions
mkdir -p "$DEST"
cp -r "$(dirname "$0")"/ext/. "$DEST"/
glib-compile-schemas "$DEST/schemas"
echo "Installed to $DEST. Log out/in (Wayland), then: gnome-extensions enable $UUID"
