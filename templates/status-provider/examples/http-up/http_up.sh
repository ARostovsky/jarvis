#!/bin/sh
# Jarvis status provider (schema v1): is a host answering over HTTP? Read-only.
# Usage: http_up.sh <host> [<host> ...]   (an id is a host name, optionally host:port)
# Env: HTTP_SCHEME (default https). Needs only `curl`.
# ids are safe for JSON because manifest idPattern only allows [A-Za-z0-9.:-].
scheme="${HTTP_SCHEME:-https}"
rows=""
for id in "$@"; do
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$scheme://$id/") || code=000
  case "$code" in
    2??|3??) state=done;   detail="HTTP $code" ;;
    000)     state=failed; detail="no answer" ;;
    *)       state=failed; detail="HTTP $code" ;;
  esac
  rows="$rows${rows:+,}{\"id\":\"$id\",\"label\":\"$id\",\"state\":\"$state\",\"detail\":\"$detail\",\"link\":\"$scheme://$id/\"}"
done
printf '{"schema":1,"checked":"%s","rows":[%s]}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rows"
