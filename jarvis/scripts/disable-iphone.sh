#!/bin/bash
# Turns off the iPhone option and forgets the passcode.
set -euo pipefail
cd "$(dirname "$0")/.."
node server/phone.js disable
