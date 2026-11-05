#!/bin/zsh
# Builds ~/Applications/Jarvis.app: the native Mac app, one window on the HUD, with the Jarvis name and icon.
set -euo pipefail
ROOT="${0:A:h:h}"
APP="$HOME/Applications/Jarvis.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ICONSET="$WORK/Jarvis.iconset"
mkdir -p "$ICONSET"
cp "$ROOT/app/icon.png" "$WORK/icon.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$WORK/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Jarvis.icns"
cp "$ROOT/app/Info.plist" "$APP/Contents/Info.plist"
swiftc -O -swift-version 5 -parse-as-library "$ROOT/app/Jarvis.swift" -o "$APP/Contents/MacOS/Jarvis"
codesign --force --sign - "$APP" # ad hoc: built here, run here. macOS needs a signature to remember the microphone answer.
touch "$APP"
echo "$APP"
