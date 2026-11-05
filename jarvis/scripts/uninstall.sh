#!/bin/zsh
# Removes the LaunchAgent and the AIC app. Leaves this folder and the logs alone.
set -euo pipefail
launchctl bootout "gui/$(id -u)/se.lamo.jarvis" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/se.lamo.jarvis.plist"
rm -rf "$HOME/Applications/AIC.app" "$HOME/Applications/Jarvis.app"
echo "AIC uninstalled."
