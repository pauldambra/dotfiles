#!/bin/sh
#
# Direct Application Installations
#
# This script installs applications that need special installation methods
# or are better installed directly from their official sources.

# Install Google Chrome if not already installed
if [ ! -d "/Applications/Google Chrome.app" ]; then
  echo "Installing Google Chrome..."
  curl -L -o /tmp/googlechrome.dmg "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg"
  hdiutil attach /tmp/googlechrome.dmg -quiet
  cp -R "/Volumes/Google Chrome/Google Chrome.app" /Applications/
  hdiutil detach "/Volumes/Google Chrome" -quiet
  rm /tmp/googlechrome.dmg
  echo "Google Chrome installed"
else
  echo "Google Chrome already installed"
fi

echo "Direct application installations completed"
