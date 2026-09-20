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
PARSED_FILE="${RUNNER_TEMP:-/tmp}/hobbo-granite-decision.json"

[[ -f "$MODEL" ]] || { echo "Missing cognition model: $MODEL" >&2; exit 2; }
[[ -x "$LLAMA_SERVER" ]] || { echo "Missing llama-server: $LLAMA_SERVER" >&2; exit 2; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required for the provider smoke test" >&2; exit 2; }

show_diagnostics() {
  echo "===== Granite API response =====" >&2
  if [[ -s "$RESPONSE_FILE" ]]; then
    jq . "$RESPONSE_FILE" >&2 2>/dev/null || cat "$RESPONSE_FILE" >&2
  else
    echo "<empty response>" >&2
  fi
  echo "===== llama-server log (tail) =====" >&2
  tail -n 200 "$LOG_FILE" >&2 2>/dev/null || true
}

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
  show_diagnostics
  exit 1
fi

if ! curl --silent --show-error --fail \
  -H 'Content-Type: application/json' \
  -X POST "http://127.0.0.1:$PORT/v1/chat/completions" \
  -d @- >"$RESPONSE_FILE" <<'JSON'
{
  "model": "hobbo-cognition",
  "temperature": 0,
  "max_tokens": 96,
  "reasoning_effort": "none",
  "chat_template_kwargs": {
    "enable_thinking": false
  },
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
    "json_schema": {
      "name": "hobbo_decision",
      "strict": true,
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
}
JSON
then
  show_diagnostics
  exit 1
fi

CONTENT_TYPE="$(jq -r '.choices[0].message.content | type' "$RESPONSE_FILE" 2>/dev/null || echo missing)"
case "$CONTENT_TYPE" in
  string)
    if ! jq -er '.choices[0].message.content | fromjson' "$RESPONSE_FILE" >"$PARSED_FILE"; then
      show_diagnostics
      exit 1
    fi
    ;;
  object)
    if ! jq -e '.choices[0].message.content' "$RESPONSE_FILE" >"$PARSED_FILE"; then
      show_diagnostics
      exit 1
    fi
    ;;
  *)
    echo "Unexpected message.content type: $CONTENT_TYPE" >&2
    show_diagnostics
    exit 1
    ;;
esac

if ! jq -e '
  type == "object" and
  (.affordance_id == "eat_owned_food" or .affordance_id == "wait") and
  (.intent | type == "string" and length > 0 and length <= 80) and
  ((keys | sort) == ["affordance_id", "intent"])
' "$PARSED_FILE" >/dev/null; then
  echo "Granite returned JSON but it does not satisfy Hobbo's decision contract." >&2
  show_diagnostics
  echo "===== Parsed decision =====" >&2
  cat "$PARSED_FILE" >&2
  exit 1
fi

if [[ "$(jq -r '.affordance_id' "$PARSED_FILE")" != "eat_owned_food" ]]; then
  echo "Granite produced a valid but incorrect decision for the deterministic fixture." >&2
  show_diagnostics
  echo "===== Parsed decision =====" >&2
  cat "$PARSED_FILE" >&2
  exit 1
fi

echo "Raw Granite endpoint smoke test passed."
echo -n "Decision: "
jq -c . "$PARSED_FILE"

(
  cd "$ROOT_DIR"
  HOBBO_COGNITION_BASE_URL="http://127.0.0.1:$PORT" \
  HOBBO_COGNITION_MODEL_ID="hobbo-cognition" \
    pnpm exec vitest run \
      packages/ai-provider/test/granite-live.integration.test.ts \
      --maxWorkers=1 \
      --no-file-parallelism
)

echo "GraniteCognitiveProvider live llama.cpp smoke test passed."

(
  cd "$ROOT_DIR"
  HOBBO_COGNITION_BASE_URL="http://127.0.0.1:$PORT" \
  HOBBO_COGNITION_MODEL_ID="hobbo-cognition" \
    pnpm exec vitest run \
      packages/runtime/live-test/dialogue.integration.test.ts \
      --maxWorkers=1 \
      --no-file-parallelism
)

echo "Granite dialogue-context live llama.cpp smoke test passed."
