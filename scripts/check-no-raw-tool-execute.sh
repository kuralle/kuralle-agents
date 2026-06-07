#!/usr/bin/env bash
# Fail if any model-facing tool passed to streamText still carries an execute function.
# Tools must be schema-only (from buildToolSet / toolToAiSdk / resolveTools).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

report() {
  local label="$1"
  local hits="$2"
  if [ -n "$hits" ]; then
    echo "✗ ${label}:"
    printf '%s\n' "$hits" | sed 's/^/    /'
    fail=1
  fi
}

CORE_SRC="$ROOT/packages/kuralle-core/src"

# Host reply must strip execute before the model sees tools.
agentreply_hits="$(grep -n 'tools: agent\.tools' "$CORE_SRC/runtime/agentReply.ts" 2>/dev/null \
  | grep -v 'buildToolSet' || true)"
report "agentReply passes raw agent.tools to node (must use buildToolSet)" "$agentreply_hits"

# streamText call sites must not pass a variable named like raw tool maps with execute.
streamtext_files="$(grep -rl 'streamText({' "$CORE_SRC" 2>/dev/null || true)"
for f in $streamtext_files; do
  # tools: must not reference agent.tools or config.tools directly
  raw_pass="$(grep -nE 'tools:\s*(agent|config|opened)\.tools' "$f" 2>/dev/null || true)"
  if [ -n "$raw_pass" ]; then
    report "streamText receives raw tool map in $f" "$raw_pass"
  fi
done

# toolToAiSdk must never attach execute (the durable seam).
toolto_hits="$(grep -n 'execute' "$CORE_SRC/tools/effect/defineTool.ts" 2>/dev/null \
  | grep -v 'execute?: never' \
  | grep -v 'execute:' \
  | grep -v 'strips \`execute\`' \
  | grep -v 'with executors' \
  | grep -v 'config\.execute' \
  | grep -v 'execute: config' || true)"
# Only flag if toolToAiSdk body assigns execute
if grep -A20 'function toolToAiSdk' "$CORE_SRC/tools/effect/defineTool.ts" | grep -qE 'execute\s*:'; then
  if ! grep -A20 'function toolToAiSdk' "$CORE_SRC/tools/effect/defineTool.ts" | grep -q 'execute?: never'; then
    report "toolToAiSdk may expose execute" "defineTool.ts toolToAiSdk"
    fail=1
  fi
fi

# Self-test: SELFTEST=1 verifies the guard logic catches a known-bad pattern.
if [ "${SELFTEST:-0}" = "1" ]; then
  planted='tools: agent.tools,'
  if echo "$planted" | grep -qE 'tools:\s*agent\.tools' && ! echo "$planted" | grep -q 'buildToolSet'; then
    echo "✓ guard logic detects planted raw-execute pattern"
    exit 0
  fi
  echo "✗ guard self-test failed"
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Refusing: model-facing tools must be schema-only (buildToolSet / toolToAiSdk)."
  echo "Wrap third-party AI SDK tools with wrapAiSdkTool() and register on AgentConfig.tools."
  exit 1
fi

echo "✓ no raw tool execute reaches streamText paths"
