#!/bin/sh
# Double-click in Finder: turns Ping Assistant fully off (autostart + watchdog + session).
"$(dirname "$(readlink -f "$0")")/ping-assistant-stop"
printf '\nPress Enter to close this window.'
read -r _
