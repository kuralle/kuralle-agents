#!/usr/bin/env bash
# Type-check every playground app under apps/playground/* so they can no longer
# rot silently. The main framework sweep (typecheck-tsconfigs.sh) only scans
# packages/, so demo apps drifted out of CI — a trailing-comma package.json and
# stale imports went uncaught. This closes that hole: find each playground
# tsconfig and run `tsc --noEmit -p` on it.
#
# Playground apps carry independent dep trees (react/next/vite/livekit), so this
# is a SEPARATE sweep from the framework gate — but it IS wired into
# `typecheck:all`, so `bun run typecheck:all` fails if a demo breaks.
#
# Exit non-zero if any in-scope tsconfig fails. Run: `bun run typecheck:playground`
set -uo pipefail
cd "$(dirname "$0")/.."

TSC=./node_modules/.bin/tsc
[ -x "$TSC" ] || TSC=packages/core/node_modules/.bin/tsc

CFGS=$(find apps/playground -name "tsconfig*.json" \
    -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.next/*" 2>/dev/null \
  | sort)

fail=0; ran=0; empty=0
echo "== playground tsconfig sweep ($(printf '%s\n' "$CFGS" | grep -c . ) configs) =="
for cfg in $CFGS; do
  # skip extends-only base configs with no own inputs
  hasinput=$(python3 -c "import json;d=json.load(open('$cfg'));print(1 if (d.get('include') or d.get('files')) else 0)" 2>/dev/null || echo 1)
  [ "$hasinput" = "0" ] && { echo "base   $cfg"; continue; }
  out=$("$TSC" --noEmit -p "$cfg" 2>&1)
  if printf '%s' "$out" | grep -q "TS18003"; then
    echo "EMPTY  $cfg  (stale config — no input files)"; empty=$((empty+1)); continue
  fi
  errs=$(printf '%s' "$out" | grep -cE "error TS")
  ran=$((ran+1))
  if [ "$errs" -eq 0 ]; then
    echo "ok     $cfg"
  else
    echo "FAIL   $cfg  ($errs errors)"
    printf '%s\n' "$out" | grep -E "error TS" | head -5 | sed 's/^/         /'
    fail=1
  fi
done

echo ""
echo "swept ${ran} playground configs; ${empty} stale-empty"
[ "$fail" -eq 0 ] && echo "✓ typecheck:playground green" || echo "✗ typecheck:playground — a demo app drifted (fix it or remove the stale demo)"
exit "$fail"
