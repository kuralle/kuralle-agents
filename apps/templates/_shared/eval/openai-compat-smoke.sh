#!/usr/bin/env bash
# PR-20 smoke — OpenAI-compatible /v1/chat/completions endpoint.
#
# Verifies that kuralle speaks OpenAI's exact wire format so Vapi,
# ElevenLabs Conversational AI, LiveKit Agents, Twilio Voice, etc.
# can plug it in as a Custom LLM with zero adapter code.
#
# Three tests:
#   1. Non-streaming POST → single JSON response in OpenAI shape
#   2. Streaming POST → SSE chunks with the right `chat.completion.chunk`
#      envelope and final `[DONE]`
#   3. Stable sessionId via X-Session-Id → same session across requests
#
# Usage:
#   export OPENAI_API_KEY=sk-... (loaded automatically from .env)
#   bash apps/templates/_shared/eval/openai-compat-smoke.sh

set -u
PORT=3170
SERVER_PID=
SERVER_LOG=$(mktemp)
TMPROOT=$(mktemp -d)
RESULTS=()

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"

if [ -z "${OPENAI_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "[setup-error] OPENAI_API_KEY required"
  exit 2
fi

echo "=== Booting knowledge-worker on port $PORT ==="
cd "$REPO_ROOT/apps/templates/knowledge-worker"
KURALLE_MEMORY_DIR="$TMPROOT/memory" PORT="$PORT" pnpm dev > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then
    echo "[boot] ready after ${i}s"
    break
  fi
  sleep 0.5
done
if ! curl -fsS "http://localhost:$PORT/" >/dev/null 2>&1; then
  echo "[boot-fail] server not reachable"
  tail -30 "$SERVER_LOG"
  exit 2
fi

record_pass() {
  RESULTS+=("PASS — $1")
  echo "  [pass] $1"
}
record_fail() {
  RESULTS+=("FAIL — $1: $2")
  echo "  [fail] $1: $2"
}

# ───── Test 1: non-streaming ────────────────────────────────────────

echo
echo "=== Test 1: POST /v1/chat/completions (non-streaming) ==="
RESP=$(curl -sS -X POST "http://localhost:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer not-needed-but-some-clients-send-it' \
  --max-time 30 \
  -d '{
    "model": "kuralle-knowledge-worker",
    "messages": [{"role": "user", "content": "Say the single word: ok"}],
    "stream": false
  }')

if echo "$RESP" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    assert d.get('object') == 'chat.completion', f'wrong object: {d.get(\"object\")}'
    assert d.get('id', '').startswith('chatcmpl-'), f'missing id: {d.get(\"id\")}'
    assert isinstance(d.get('choices'), list) and len(d['choices']) > 0, 'no choices'
    msg = d['choices'][0].get('message', {})
    assert msg.get('role') == 'assistant', 'wrong role'
    content = msg.get('content', '')
    assert content, 'empty content'
    print('OK', content[:80])
except (AssertionError, Exception) as e:
    print(f'FAIL: {e}', file=sys.stderr)
    sys.exit(1)
"; then
  record_pass "non-streaming response has OpenAI shape"
else
  record_fail "non-streaming" "shape mismatch — got: $(echo $RESP | head -c 200)"
fi

# ───── Test 2: streaming ────────────────────────────────────────────

echo
echo "=== Test 2: POST /v1/chat/completions (streaming SSE) ==="
STREAM_OUT=$(curl -sN -X POST "http://localhost:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  --max-time 30 \
  -d '{
    "model": "kuralle-knowledge-worker",
    "messages": [{"role": "user", "content": "Say exactly: streaming works"}],
    "stream": true
  }')

# Verify SSE format: starts with data:, contains chat.completion.chunk, ends with [DONE]
if echo "$STREAM_OUT" | python3 -c "
import sys
lines = [l.strip() for l in sys.stdin if l.strip()]
data_lines = [l[5:].strip() for l in lines if l.startswith('data:')]
assert len(data_lines) > 0, 'no data: lines'
# Last line must be [DONE]
assert data_lines[-1] == '[DONE]', f'last data line is not [DONE]: {data_lines[-1]}'
# Earlier lines must be valid JSON with chat.completion.chunk shape
import json
seen_role = False
seen_content = False
seen_finish = False
for line in data_lines[:-1]:
    obj = json.loads(line)
    assert obj.get('object') == 'chat.completion.chunk', f'wrong object: {obj.get(\"object\")}'
    assert isinstance(obj.get('choices'), list)
    delta = obj['choices'][0].get('delta', {})
    if delta.get('role') == 'assistant':
        seen_role = True
    if delta.get('content'):
        seen_content = True
    if obj['choices'][0].get('finish_reason'):
        seen_finish = True
assert seen_role, 'never saw role:assistant chunk'
assert seen_content, 'never saw delta.content chunk'
assert seen_finish, 'never saw finish_reason chunk'
print('OK')
" 2>&1; then
  record_pass "streaming response: role chunk + content deltas + finish + [DONE]"
else
  record_fail "streaming" "shape mismatch — head: $(echo $STREAM_OUT | head -c 300)"
fi

# ───── Test 3: session continuity via X-Session-Id ───────────────────

echo
echo "=== Test 3: X-Session-Id continuity (Vapi/ElevenLabs-style) ==="
SID="oai-smoke-$(date +%s)"

# First request — establish a fact
curl -sS -X POST "http://localhost:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H "x-session-id: $SID" \
  -H "x-user-id: ${SID}-user" \
  --max-time 30 \
  -d '{
    "model": "kuralle-knowledge-worker",
    "messages": [{"role":"user","content":"Remember in my USER block: I prefer chocolate ice cream. Use memory_block. Confirm when saved."}],
    "stream": false
  }' > /dev/null
sleep 1

# Second request — same session — ask what the agent remembers
RECALL=$(curl -sS -X POST "http://localhost:$PORT/v1/chat/completions" \
  -H 'content-type: application/json' \
  -H "x-session-id: $SID" \
  -H "x-user-id: ${SID}-user" \
  --max-time 30 \
  -d '{
    "model": "kuralle-knowledge-worker",
    "messages": [{"role":"user","content":"What ice cream do I prefer?"}],
    "stream": false
  }')

RECALL_TEXT=$(echo "$RECALL" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin)['choices'][0]['message']['content'])
except Exception as e:
    print(f'PARSE-ERR: {e}', file=sys.stderr)
")

if echo "$RECALL_TEXT" | grep -qi 'chocolate'; then
  record_pass "session continuity via X-Session-Id — agent recalled 'chocolate'"
else
  record_fail "session continuity" "did not recall 'chocolate' — got: ${RECALL_TEXT:0:200}"
fi

# ───── Summary ──────────────────────────────────────────────────────

echo
echo "════════════════════════════════════════════════════"
echo "PR-20 OpenAI-compat smoke results"
echo "════════════════════════════════════════════════════"
PASS=0; FAIL=0
for r in "${RESULTS[@]}"; do
  echo "$r"
  [[ "$r" == PASS* ]] && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
done
echo "─────────────────────────────────────────────────────"
echo "$PASS pass / $FAIL fail"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
