#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCK_FILE="${HOBBO_MODELS_LOCK:-$ROOT_DIR/models/models.lock.json}"
MODEL_DIR="${HOBBO_MODEL_DIR:-$ROOT_DIR/.cache/models}"
LLAMA_SERVER="${LLAMA_SERVER:-$ROOT_DIR/.cache/llama.cpp/build/bin/llama-server}"
PORT="${HOBBO_COGNITION_PORT:-8086}"

MODEL_FILE="$(jq -r '.models.cognition.file' "$LOCK_FILE")"
MODEL="$MODEL_DIR/$MODEL_FILE"
LOG_FILE="${RUNNER_TEMP:-/tmp}/hobbo-granite-server.log"
RESPONSE_FILE="${RUNNER_TEMP:-/tmp}/hobbo-granite-response.json"

[[ -f "$MODEL" ]] || { echo "Missing cognition model: $MODEL" >&2; exit 2; }
[[ -x "$LLAMA_SERVER" ]] || { echo "Missing llama-server: $LLAMA_SERVER" >&2; exit 2; }

"$LLAMA_SERVER" \
  -m "$MODEL" \
  --alias hobbo-cognition \
  --host 127.0.0.1 \
  --port "$PORT" \
  -c 4096 \
  -np 1 \
  -ngl 0 \
  --jinja \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true; wait "$SERVER_PID" >/dev/null 2>&1 || true' EXIT

if ! bash "$ROOT_DIR/scripts/ci/wait-http.sh" "http://127.0.0.1:$PORT/health" 240; then
  cat "$LOG_FILE" >&2
  exit 1
fi

curl --silent --show-error --fail \
  -H 'Content-Type: application/json' \
  -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
  -d @- >"$RESPONSE_FILE" <<'JSON'
{
  "model": "hobbo-cognition",
  "temperature": 0,
  "max_tokens": 96,
  "messages": [
    {
      "role": "system",
      "content": "You are the decision component of a deterministic social simulation. Select exactly one affordance supplied by the simulation. Never invent actions or world state. Return only the schema-constrained result."
    },
    {
      "role": "user",
      "content": "Actor state: hunger is critically high and the actor owns edible food. Choose one available affordance. Available affordances: eat_owned_food = eat the owned sandwich now; wait = do nothing."
    }
  ],
  "response_format": {
    "type": "json_schema",
    "schema": {
      "type": "object",
      "properties": {
        "affordance_id": {
          "type": "string",
          "enum": ["eat_owned_food", "wait"]
        },
        "intent": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        }
      },
      "required": ["affordance_id", "intent"],
      "additionalProperties": false
    }
  }
}
JSON

CONTENT="$(jq -er '.choices[0].message.content' "$RESPONSE_FILE")"
printf '%s\n' "$CONTENT" | jq -e '
  type == "object" and
  (.affordance_id == "eat_owned_food" or .affordance_id == "wait") and
  (.intent | type == "string" and length > 0)
' >/dev/null

echo "Granite smoke test passed."
echo "Decision: $CONTENT"
