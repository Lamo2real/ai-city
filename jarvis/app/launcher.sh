#!/bin/sh
# Chrome's app mode gives Jarvis a window of its own. Its own profile lets sound play
# when you say "Yo Jarvis" without clicking first, and keeps listening when the window is behind others.
# It opens straight into the City, full screen.
if [ -d "/Applications/Google Chrome.app" ]; then
  exec open -na "Google Chrome" --args "--app=http://localhost:7777/?view=city" --start-fullscreen "--user-data-dir=$HOME/Library/Application Support/Jarvis/chrome" --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --no-first-run
fi
exec open "http://localhost:7777/?view=city"
