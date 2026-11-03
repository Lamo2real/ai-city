#!/bin/bash
# Turns on the iPhone option. The passcode is typed here, never passed as an argument.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "This network becomes the only one Jarvis opens on:"
node server/phone.js network
read -r -p "Is this your home Wi-Fi? [y/N] " home
if [[ "$home" != "y" && "$home" != "Y" ]]; then
  echo "Nothing was changed. Run this again from your home Wi-Fi."
  exit 1
fi

read -r -s -p "Choose a passcode (at least 6 characters): " first; echo
read -r -s -p "Again: " second; echo
if [[ "$first" != "$second" ]]; then
  echo "They did not match. Nothing was changed."
  exit 1
fi
printf '%s' "$first" | node server/phone.js enable

state="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getblockall || true)"
if [[ "$state" == *"blocking all"* ]]; then
  echo
  echo "The Mac's firewall is blocking all incoming connections, so the iPhone cannot connect yet."
fi
