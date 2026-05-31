#!/usr/bin/env bash
# Procedures smoke test.
#
# Verifies: cedar-health billing agent registers verify-insurance as
# run_verify-insurance, invokes it from chat, and streams procedure events
# through the normal SSE channel.

set -u
PORT=3173
TMPROOT=$(mktemp -d -t kuralle-procedures-smoke.XXXXXX)
SERVER_PID=
SERVER_LOG="$TMPROOT/server.log"
SESSION_ID="procedures-$(date +%s)"
USER_ID="procedures-smoke-user"

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

send_turn() {
  local message="$1"
  local body
  body=$(printf '{"message":%s,"sessionId":"%s","userId":"%s"}' \
    "$(printf '%s' "$message" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')" \
    "$SESSION_ID" "$USER_ID")
  curl -sN -X POST "http://localhost:$PORT/api/chat/sse" \
    -H 'content-type: application/json' \
    --max-time 90 \
    --data-binary "$body"
}

echo "=== kuralle procedures smoke ==="
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

RAW=$(send_turn "Route this to billing and use the run_verify-insurance procedure. MRN: MRN-100231. DOB: 1981-04-12. Invoice id: inv_chen_2025_06. Please verify insurance eligibility.")

if ! printf '%s' "$RAW" | grep -q '"type":"procedure-start"'; then
  echo "[fail] procedure-start event missing"
  exit 1
fi

if ! printf '%s' "$RAW" | grep -q '"procedureId":"verify-insurance"'; then
  echo "[fail] verify-insurance procedure id missing"
  exit 1
fi

for step in verify-identity load-invoice check-eligibility summarize-eligibility; do
  if ! printf '%s' "$RAW" | grep -q "\"stepId\":\"$step\""; then
    echo "[fail] procedure step event missing for $step"
    exit 1
  fi
done

if ! printf '%s' "$RAW" | grep -q '"type":"procedure-end"'; then
  echo "[fail] procedure-end event missing"
  exit 1
fi

if ! printf '%s' "$RAW" | grep -q '"outcome":"success"'; then
  echo "[fail] procedure did not finish with success"
  exit 1
fi

if ! printf '%s' "$RAW" | grep -q '"eligible":true'; then
  echo "[fail] procedure output did not include eligible=true"
  exit 1
fi

echo "[pass] verify-insurance procedure started"
echo "[pass] all four procedure steps streamed"
echo "[pass] procedure completed successfully with eligible=true"
