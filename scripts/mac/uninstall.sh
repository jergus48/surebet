#!/bin/bash
# Stop and remove the surebet bot LaunchAgent. Keeps data/ (settings, history).
LABEL="com.surebet.bot"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Surebet bot stopped and removed from login items. data/ was kept."
