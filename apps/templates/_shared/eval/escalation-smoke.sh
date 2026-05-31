#!/usr/bin/env bash
# Confidence escalation smoke test.
#
# Verifies: low-confidence question -> escalation-triggered event with handler
# outcome -> handover text only. The outcomes smoke adds the canonical persisted
# 'escalated' outcome check.

set -u
PORT=3171
TMPROOT=$(mktemp -d -t kuralle-escalation-smoke.XXXXXX)
SERVER_PID=
SERVER_LOG="$TMPROOT/server.log"
SESSION_ID="escalation-low-$(date +%s)"
USER_ID="escalation-smoke-user"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  echo
  echo "─── server log (last 30 lines) ───────────────────────────"
  tail -30 "$SERVER_LOG" 2>/dev/null || true
  echo
}
trap cleanup EXIT

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"

if [ -z "${OPENAI_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO_ROOT/.env"; set +a
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[setup-error] OPENAI_API_KEY must be set in env or in $REPO_ROOT/.env"
  exit 2
fi

TEMPLATE_DIR="$REPO_ROOT/apps/templates/cedar-health"

extract_text() {
  python3 -c '
import json, sys
out = []
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("data:"):
        continue
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        continue
    try:
        obj = json.loads(payload)
    except Exception:
        continue
    if obj.get("type") == "text-delta":
        out.append(obj.get("delta") or obj.get("text") or "")
sys.stdout.write("".join(out))
'
}

send_turn() {
  local message="$1"
  local body
  body=$(printf '{"message":%s,"sessionId":"%s","userId":"%s"}' \
    "$(printf '%s' "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')" \
    "$SESSION_ID" "$USER_ID")
  curl -sN -X POST "http://localhost:$PORT/api/chat/sse" \
    -H 'content-type: application/json' \
    --max-time 60 \
    --data-binary "$body"
}

echo "=== kuralle confidence escalation smoke ==="
echo "Port:      $PORT"
echo "Tmp root:  $TMPROOT"
echo "Template:  cedar-health"
echo

cd "$TEMPLATE_DIR"
KURALLE_MEMORY_DIR="$TMPROOT/memory" PORT="$PORT" pnpm dev > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
echo "[boot] server pid=$SERVER_PID, waiting for ready..."

for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then
    echo "[boot] ready after ${i}s"
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then
  echo "[boot-fail] server not reachable after 15s"
  exit 2
fi

RAW=$(send_turn "Please explain Kubernetes pod networking in detail.")
TXT=$(printf '%s' "$RAW" | extract_text)

if ! printf '%s' "$RAW" | grep -q '"type":"escalation-triggered"'; then
  echo "[fail] escalation-triggered event missing"
  exit 1
fi

if ! printf '%s' "$RAW" | grep -q '"reason":"low-confidence"'; then
  echo "[fail] escalation reason was not low-confidence"
  exit 1
fi

if ! printf '%s' "$RAW" | grep -q '"handlerOutcome":"queued"'; then
  echo "[fail] escalation handler outcome missing or unexpected"
  exit 1
fi

if ! printf '%s' "$TXT" | grep -q 'Cedar Health teammate'; then
  echo "[fail] handover text missing; got: ${TXT:0:200}"
  exit 1
fi

if printf '%s' "$TXT" | grep -qi 'kubernetes'; then
  echo "[fail] generated answer text leaked into escalation response: ${TXT:0:300}"
  exit 1
fi

echo "[pass] low-confidence escalation event observed"
echo "[pass] handler outcome surfaced"
echo "[pass] only handover text streamed"
