#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK_FILE="${HOBBO_MODELS_LOCK:-$ROOT_DIR/models/models.lock.json}"
MODEL_DIR="${HOBBO_MODEL_DIR:-$ROOT_DIR/.cache/models}"
LLAMA_SERVER="${LLAMA_SERVER:-$ROOT_DIR/.cache/llama.cpp/build/bin/llama-server}"
PORT="${HOBBO_EMBEDDING_PORT:-8087}"

MODEL_FILE="$(jq -r '.models.embeddings.file' "$LOCK_FILE")"
MODEL="$MODEL_DIR/$MODEL_FILE"
LOG_FILE="${RUNNER_TEMP:-/tmp}/hobbo-nomic-server.log"
RESPONSE_FILE="${RUNNER_TEMP:-/tmp}/hobbo-nomic-response.json"

[[ -f "$MODEL" ]] || { echo "Missing embedding model: $MODEL" >&2; exit 2; }
[[ -x "$LLAMA_SERVER" ]] || { echo "Missing llama-server: $LLAMA_SERVER" >&2; exit 2; }

"$LLAMA_SERVER" \
  -m "$MODEL" \
  --alias hobbo-embeddings \
  --host 127.0.0.1 \
  --port "$PORT" \
  -c 2048 \
  -np 1 \
  -ngl 0 \
  --embedding \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" >/dev/null 2>&1 || true' EXIT

if ! bash "$ROOT_DIR/scripts/ci/wait-http.sh" "http://127.0.0.1:$PORT/health" 180; then
  cat "$LOG_FILE" >&2
  exit 1
fi

curl --silent --show-error --fail \
  -H 'Content-Type: application/json' \
  -X POST "http://127.0.0.1:$PORT/v1/embeddings" \
  -d @- >"$RESPONSE_FILE" <<'JSON'
{
  "model": "hobbo-embeddings",
  "input": [
    "search_query: personaje con hambre buscando una solución inmediata",
    "search_document: el personaje tiene hambre elevada y posee comida disponible"
  ]
}
JSON

jq -e '
  (.data | length) == 2 and
  ((.data[0].embedding | length) > 0) and
  ((.data[0].embedding | length) == (.data[1].embedding | length)) and
  ([.data[].embedding[] | select((type != "number") or (isnan) or (isinfinite))] | length) == 0
' "$RESPONSE_FILE" >/dev/null

DIM="$(jq -r '.data[0].embedding | length' "$RESPONSE_FILE")"
echo "Nomic embedding smoke test passed."
echo "Embedding dimensions returned by llama.cpp: $DIM"
