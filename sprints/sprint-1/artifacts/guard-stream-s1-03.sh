#!/usr/bin/env bash
# S1-03 guard: typecheck:all must fail with ONLY the frozen baseline configs (no new red).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
log=$(mktemp)
bun run typecheck:all > "$log" 2>&1 || true   # baseline is red (exit 1) — expected
actual=$(grep -E '^FAIL ' "$log" | awk '{print $2}' | sort -u)
baseline=$(printf '%s\n' \
  packages/kuralle-core/test/tsconfig.json \
  packages/kuralle-engagement/examples/booking/tsconfig.json \
  packages/kuralle-engagement/examples/clothing/tsconfig.json \
  packages/kuralle-engagement/examples/pharmacy/tsconfig.json | sort -u)
newfails=$(comm -23 <(printf '%s\n' "$actual") <(printf '%s\n' "$baseline"))
coreerrs=$(grep -E '^FAIL +packages/kuralle-core/test/tsconfig.json' "$log" | grep -oE '\([0-9]+ errors?\)' | grep -oE '[0-9]+' | head -1)
coreerrs=${coreerrs:-0}
echo "=== typecheck:all FAIL configs this run ==="; printf '%s\n' "$actual"
echo "=== NEW failures beyond baseline (must be empty) ==="; printf '%s\n' "$newfails"
echo "=== kuralle-core/test error count: $coreerrs (baseline 5, must be <= 5) ==="
if [ -n "$newfails" ]; then echo "GUARD FAIL: new typecheck:all failure(s)"; exit 1; fi
if [ "$coreerrs" -gt 5 ]; then echo "GUARD FAIL: kuralle-core/test errors increased"; exit 1; fi
echo "GUARD OK: no new typecheck:all failures"; exit 0
