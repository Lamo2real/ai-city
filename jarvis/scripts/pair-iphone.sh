#!/bin/zsh
# Pairs the Jarvis iPhone app: shows a QR code for it to scan. Run again to rotate the token; `unpair` removes it.
set -euo pipefail
cd "${0:A:h:h}"
exec node server/app-api.js "${1:-pair}"
