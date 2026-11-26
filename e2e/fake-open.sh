#!/bin/sh
# Stand-in for xdg-open (JARVIS_OPEN_CMD in tests): appends the path it gets to $JARVIS_OPEN_LOG.
printf '%s\n' "$1" >> "$JARVIS_OPEN_LOG"
