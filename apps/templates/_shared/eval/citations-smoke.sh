#!/usr/bin/env bash
# Citation smoke — verifies native SSE citation events and persisted
# assistant message metadata against the knowledge-worker template.

set -euo pipefail

PORT=3181
TMPROOT=$(mktemp -d -t kuralle-citations.XXXXXX)
SESSION_ID="citations-smoke-$(date +%s)"
USER_ID="citations-user-$(date +%s)"
SERVER_PID=
SERVER_LOG="$TMPROOT/server.log"

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  echo
  echo "--- server log ---"
  python3 - "$SERVER_LOG" <<'PY'
import sys
path = sys.argv[1]
try:
    lines = open(path, "r", encoding="utf-8", errors="replace").read().splitlines()
except FileNotFoundError:
    lines = []
for line in lines[-30:]:
    print(line)
PY
}
trap cleanup EXIT

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"

if [ -z "${OPENAI_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[setup-error] OPENAI_API_KEY must be set in env or in $REPO_ROOT/.env"
  exit 2
fi

TEMPLATE_DIR="$REPO_ROOT/apps/templates/knowledge-worker"

echo "=== kuralle citations smoke ==="
echo "Port:      $PORT"
echo "Tmp root:  $TMPROOT"
echo "Session:   $SESSION_ID"
echo

cd "$TEMPLATE_DIR"
KURALLE_MEMORY_DIR="$TMPROOT/memory" KURALLE_THREE_PHASE_SMOKE=1 PORT="$PORT" \
  pnpm dev > "$SERVER_LOG" 2>&1 &
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

body=$(python3 - <<PY
import json
print(json.dumps({
  "message": "Which active projects mention the Q3 strategy doc and Tailwind upgrade?",
  "sessionId": "$SESSION_ID",
  "userId": "$USER_ID",
}))
PY
)

SSE_FILE="$TMPROOT/turn.sse"
SESSION_FILE="$TMPROOT/session.json"

curl -sN -X POST "http://localhost:$PORT/api/chat/sse" \
  -H 'content-type: application/json' \
  --max-time 90 \
  --data-binary "$body" > "$SSE_FILE"

python3 - "$SSE_FILE" <<'PY'
import json, sys
events = []
for line in open(sys.argv[1], "r", encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line.startswith("data:"):
        continue
    payload = line[5:].strip()
    if not payload:
        continue
    try:
        events.append(json.loads(payload))
    except Exception:
        pass
citations = [event for event in events if event.get("type") == "knowledge-citation"]
if not citations:
    print("[fail] no knowledge-citation event emitted")
    sys.exit(1)
if not any(event.get("sourceId") == "active-projects" for event in citations):
    print("[fail] expected active-projects citation, got:", citations)
    sys.exit(1)
print("[pass] knowledge-citation event emitted")
PY

curl -fsS "http://localhost:$PORT/api/session/$SESSION_ID" > "$SESSION_FILE"

python3 - "$SESSION_FILE" <<'PY'
import json, sys
session = json.load(open(sys.argv[1], "r", encoding="utf-8"))
messages = session.get("messages") or []
assistant = [message for message in messages if message.get("role") == "assistant"]
if not assistant:
    print("[fail] no assistant messages in session fetch")
    sys.exit(1)
citations = (assistant[-1].get("metadata") or {}).get("citations") or []
if not citations:
    print("[fail] assistant message missing metadata.citations")
    sys.exit(1)
if not any(citation.get("id") == "active-projects" for citation in citations):
    print("[fail] expected active-projects in metadata.citations, got:", citations)
    sys.exit(1)
print("[pass] assistant metadata.citations persisted")
PY

echo
echo "citations smoke passed"
