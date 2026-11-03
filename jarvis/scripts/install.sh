#!/bin/zsh
# Installs the LaunchAgent and the Jarvis app. Secrets stay in ~/.zshrc: the plist holds none.
set -euo pipefail
ROOT="${0:A:h:h}"
PLIST="$HOME/Library/LaunchAgents/se.lamo.jarvis.plist"
DOMAIN="gui/$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/Applications"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" "$ROOT/app/se.lamo.jarvis.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "$DOMAIN/se.lamo.jarvis" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
"$ROOT/scripts/build-app.sh" >/dev/null
echo "Jarvis is running at http://localhost:7777 and starts at login. App: ~/Applications/Jarvis.app"
