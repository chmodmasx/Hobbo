#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK_FILE="${HOBBO_MODELS_LOCK:-$ROOT_DIR/models/models.lock.json}"
MODEL_DIR="${HOBBO_MODEL_DIR:-$ROOT_DIR/.cache/models}"
ROLE="${1:-all}"

command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 2; }

mkdir -p "$MODEL_DIR"

roles=()
if [[ "$ROLE" == "all" ]]; then
  mapfile -t roles < <(jq -r '.models | keys[]' "$LOCK_FILE")
else
  jq -e --arg role "$ROLE" '.models[$role] != null' "$LOCK_FILE" >/dev/null || {
    echo "Unknown model role: $ROLE" >&2
    exit 2
  }
  roles=("$ROLE")
fi

for role in "${roles[@]}"; do
  file="$(jq -r --arg role "$role" '.models[$role].file' "$LOCK_FILE")"
  url="$(jq -r --arg role "$role" '.models[$role].url' "$LOCK_FILE")"
  expected="$(jq -r --arg role "$role" '.models[$role].sha256' "$LOCK_FILE")"
  target="$MODEL_DIR/$file"

  if [[ -f "$target" ]]; then
    actual="$(sha256sum "$target" | awk '{print $1}')"
    if [[ "$actual" == "$expected" ]]; then
      echo "[$role] cache hit: $file"
      continue
    fi
    echo "[$role] checksum mismatch in cached file; redownloading" >&2
    rm -f "$target"
  fi

  echo "[$role] downloading $file"
  tmp="$target.part"
  rm -f "$tmp"
  curl --fail --location --retry 5 --retry-delay 2 --continue-at - --output "$tmp" "$url"

  actual="$(sha256sum "$tmp" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "[$role] SHA256 verification failed" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    rm -f "$tmp"
    exit 1
  fi

  mv "$tmp" "$target"
  echo "[$role] verified: $file"
done
