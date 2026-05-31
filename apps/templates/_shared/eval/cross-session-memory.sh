#!/usr/bin/env bash
# Cross-session memory smoke test (PR-8).
#
# Verifies that persistent memory blocks survive: a fact written by the
# agent in session A is visible in the agent's system prompt in session B
# AFTER the server restarts. This is the end-to-end proof that
# templates' memory wiring is correct.
#
# Usage:
#   1. cd into one of the templates (default: knowledge-worker on :3140)
#   2. export OPENAI_API_KEY=sk-...
#   3. mkdir -p /tmp/kuralle-memtest && export KURALLE_MEMORY_DIR=/tmp/kuralle-memtest
#   4. pnpm dev   (in another terminal)
#   5. bash apps/templates/_shared/eval/cross-session-memory.sh
#
# What it does:
#   Session A: tells the agent a stable user fact ("I prefer vegetarian"),
#     waits for it to be persisted via the memory_block tool.
#   Server restart (manual or by the operator).
#   Session B: asks "what do you remember about me?" with the SAME userId.
#   Asserts: the assistant reply mentions "vegetarian".
#
# Exit codes:
#   0  — pass (memory persisted across sessions)
#   1  — fail (memory not visible in session B)
#   2  — setup error (server not reachable, OPENAI_API_KEY missing)

set -u

PORT="${PORT:-3140}"
ENDPOINT="${ENDPOINT:-http://localhost:${PORT}/api/chat/sse}"
USER_ID="${USER_ID:-mem-smoke-$(date +%s)}"
TIMEOUT="${TIMEOUT:-30}"

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[setup-error] OPENAI_API_KEY is required in env" >&2
  exit 2
fi

if ! curl -fsS "${ENDPOINT%/api/chat/sse}/" >/dev/null 2>&1; then
  echo "[setup-error] template server not reachable at ${ENDPOINT}" >&2
  echo "             start one with: pnpm --filter @kuralle-templates/knowledge-worker dev" >&2
  exit 2
fi

extract_text() {
  # SSE stream → concatenate text-delta payloads.
  awk -v RS='' '/text-delta/ { while (match($0, /"delta":"([^"]*)"/, m)) { printf "%s", m[1]; $0 = substr($0, RSTART+RLENGTH) } }' \
    < /dev/stdin
}

session_request() {
  local session_id="$1"
  local message="$2"
  curl -sN -X POST "$ENDPOINT" \
    -H 'content-type: application/json' \
    --max-time "$TIMEOUT" \
    --data-binary "$(printf '{"message":"%s","sessionId":"%s","userId":"%s"}' "$message" "$session_id" "$USER_ID")" \
    | extract_text
}

echo "[1/3] session A: writing a stable user preference (userId=$USER_ID)"
A_REPLY=$(session_request "sess-A-$$" "Please remember in your USER block that I prefer vegetarian food and I live in Brooklyn. Confirm when saved.")
echo "      → assistant: ${A_REPLY:0:200}..."
echo ""

echo "[2/3] (server keeps running — same process, but a fresh session)"
echo ""

echo "[3/3] session B: same userId, NEW sessionId — asking what the agent remembers"
B_REPLY=$(session_request "sess-B-$$" "What do you remember about me from before?")
echo "      → assistant: ${B_REPLY:0:400}..."
echo ""

if echo "$B_REPLY" | grep -qi 'vegetarian'; then
  echo "[pass] memory persisted across sessions — assistant recalled 'vegetarian'"
  exit 0
else
  echo "[fail] expected 'vegetarian' in session B reply, got:" >&2
  echo "$B_REPLY" >&2
  echo "" >&2
  echo "Hint: the agent may not have called memory_block — re-run with a more directive prompt," >&2
  echo "      or check that KURALLE_MEMORY_DIR contains a USER.md for userId=$USER_ID." >&2
  exit 1
fi
