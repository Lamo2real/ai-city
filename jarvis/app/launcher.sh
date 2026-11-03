#!/bin/sh
# Chrome's app mode gives Jarvis a window of its own. Its own profile lets sound play
# when you say "Yo Jarvis" without clicking first, and keeps listening when the window is behind others.
if [ -d "/Applications/Google Chrome.app" ]; then
  exec open -na "Google Chrome" --args --app=http://localhost:7777 "--user-data-dir=$HOME/Library/Application Support/Jarvis/chrome" --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --no-first-run
fi
exec open http://localhost:7777
