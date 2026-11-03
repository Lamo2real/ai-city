#!/bin/zsh
# Stops serving Jarvis on the tailnet. Tailscale itself stays installed.
set -euo pipefail
cd "${0:A:h:h}"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
[ -x "$TS" ] && "$TS" serve --https=443 off || true
node server/tailnet.js disable
launchctl kickstart -k "gui/$(id -u)/se.lamo.jarvis"
echo "Jarvis is no longer on the tailnet."
