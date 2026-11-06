#!/bin/bash
# Install the surebet bot as a macOS LaunchAgent:
#   - starts when you log in, restarts itself if it crashes (KeepAlive)
#   - runs under `caffeinate -i` so the Mac does not idle-sleep while it runs
#   - logs to data/bot.log
# Usage (from the project folder):  bash scripts/mac/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.surebet.bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js not found. Install it first:  brew install node   (or the macOS installer from nodejs.org)"; exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$("$NODE" -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Node $("$NODE" -v) is too old; need 22.13 or newer (built-in SQLite)."; exit 1
fi
if [ ! -d "/Applications/Google Chrome.app" ] && [ -z "${CHROME_PATH:-}" ]; then
  echo "Google Chrome not found in /Applications. Install Chrome (or set CHROME_PATH)."; exit 1
fi

echo "Installing dependencies..."
cd "$DIR" && npm install --no-fund --no-audit
mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"

# Keep Chrome's background tabs running at full speed (App Nap off for Chrome).
defaults write com.google.Chrome NSAppSleepDisabled -bool YES || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>$NODE</string>
    <string>$DIR/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/data/bot.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/bot.log</string>
</dict>
</plist>
EOF

# (Re)load the agent in the logged-in user's session.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '<mac-ip>')"
cat <<MSG

Surebet bot installed and running.
  Dashboard on this Mac:  http://localhost:8080   (first visit: choose a password)
  From your phone (same Wi-Fi):  http://$IP:8080
  Log:      tail -f "$DIR/data/bot.log"
  Restart:  launchctl kickstart -k gui/$(id -u)/$LABEL
  Remove:   bash scripts/mac/uninstall.sh

For true 24/7, also set (once):
  System Settings > Users & Groups > Automatically log in as: <you>
  System Settings > Energy > Start up automatically after a power failure: on
  System Settings > Energy > Prevent automatic sleeping when the display is off: on
MSG
