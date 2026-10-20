#!/bin/sh
# Double-click in Finder: opens Terminal and attaches to the always-on Ping Assistant session.
# readlink -f: works when this file is reached through an alias/symlink on the Desktop or in the Dock.
exec "$(dirname "$(readlink -f "$0")")/ping-assistant-session"
