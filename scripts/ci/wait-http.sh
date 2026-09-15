#!/usr/bin/env bash
set -euo pipefail

URL="${1:?usage: wait-http.sh <url> [timeout-seconds]}"
TIMEOUT="${2:-180}"
START="$(date +%s)"

while true; do
  if curl --silent --fail "$URL" >/dev/null 2>&1; then
    exit 0
  fi

  NOW="$(date +%s)"
  if (( NOW - START >= TIMEOUT )); then
    echo "Timed out waiting for $URL after ${TIMEOUT}s" >&2
    exit 1
  fi

  sleep 2
done
