#!/bin/zsh
# Serves Jarvis over HTTPS on your private tailnet, for your Tailscale login only. Never public.
set -euo pipefail
cd "${0:A:h:h}"
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
[ -x "$TS" ] || { echo "Tailscale is not installed: brew install --cask tailscale-app"; exit 1; }
STATUS="$("$TS" status --json)" || { echo "Tailscale is not running. Open the app and log in."; exit 1; }
read -r STATE HOST LOGIN <<<"$(print -r -- "$STATUS" | python3 -c 'import json,sys; j=json.load(sys.stdin); s=j["Self"]; print(j["BackendState"], s["DNSName"].rstrip("."), j["User"][str(s["UserID"])]["LoginName"])')"
[ "$STATE" = "Running" ] || { echo "Tailscale is not logged in ($STATE). Open the app and log in."; exit 1; }
node server/tailnet.js enable "$HOST" "$LOGIN"
"$TS" serve --bg --https=443 http://127.0.0.1:7778
launchctl kickstart -k "gui/$(id -u)/se.lamo.jarvis"
echo "On your iPhone, with Tailscale on, open: https://$HOST"
echo "Only $LOGIN gets in."
