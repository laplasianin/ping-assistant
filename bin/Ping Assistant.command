#!/bin/sh
# Double-click in Finder: opens Terminal and attaches to the always-on Ping Assistant session.
exec "$(dirname "$0")/ping-assistant-session"
