#!/bin/bash
# Pull the latest code, refresh dependencies and restart the LaunchAgent.
# Usage (from the project folder):  bash scripts/mac/update.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$DIR"
git pull --ff-only
npm install --no-fund --no-audit
launchctl kickstart -k "gui/$(id -u)/com.surebet.bot"
echo "Updated and restarted. Log: tail -f \"$DIR/data/bot.log\""
