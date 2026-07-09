#!/usr/bin/env bash
# Aggregate type-check across the surfaces that are NOT covered by each
# package's own `src/**` build: core examples.
# (Per-package src/ is type-checked by `bun run build`; this gate covers the
# example code that imports those packages.)
#
# Playground apps under apps/playground/* are intentionally EXCLUDED — they are
# R&D/demos, not a supported surface, and several carry their own unrelated
# errors. Type-check an individual one on demand with:
#   ./node_modules/.bin/tsc --noEmit -p apps/playground/<name>/tsconfig.json
set -uo pipefail
cd "$(dirname "$0")/.."

TSC=./node_modules/.bin/tsc
[ -x "$TSC" ] || TSC=packages/core/node_modules/.bin/tsc

fail=0
run() { # <label> <tsconfig path>
  local label="$1" cfg="$2"
  if [ ! -f "$cfg" ]; then echo "skip   $label (no $cfg)"; return; fi
  local out errs
  out=$("$TSC" --noEmit -p "$cfg" 2>&1)
  errs=$(printf '%s' "$out" | grep -cE "error TS")
  if [ "$errs" -eq 0 ]; then
    echo "ok     $label"
  else
    echo "FAIL   $label ($errs errors)"
    printf '%s\n' "$out" | grep -E "error TS" | head -5 | sed 's/^/         /'
    fail=1
  fi
}

echo "== core examples =="
run "core/examples" "packages/core/tsconfig.examples.json"

echo ""
[ "$fail" -eq 0 ] && echo "✓ typecheck: all green" || echo "✗ typecheck: failures above"
exit "$fail"
