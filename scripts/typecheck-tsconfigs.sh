#!/usr/bin/env bash
# Discover and run EVERY framework tsconfig — src, test, AND examples — so that
# deleted-API imports in test/example files can no longer rot silently. The
# per-package `build` only compiles `src/**` (its tsconfig `include`); a test or
# example file that imports a removed symbol never breaks the build. This sweep
# closes that hole: it finds each tsconfig under packages/ and runs
# `tsc --noEmit -p` on it.
#
# Standalone apps (docs)
# are EXCLUDED — they have independent dep trees (react/next/etc.) and their
# errors are missing-deps, not v2 drift. Type-check one on demand directly.
#
# Exit non-zero if any in-scope tsconfig fails. Run: `bun run typecheck:all`
set -uo pipefail
cd "$(dirname "$0")/.."

TSC=./node_modules/.bin/tsc
[ -x "$TSC" ] || TSC=packages/core/node_modules/.bin/tsc

# Standalone-app configs to skip (independent dep trees, not framework surface).
SKIP_RE='apps/docs'

CFGS=$(find packages -name "tsconfig*.json" \
    -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.next/*" 2>/dev/null \
  | grep -vE "$SKIP_RE" | sort)

fail=0; empty=0; ran=0
echo "== framework tsconfig sweep ($(printf '%s\n' "$CFGS" | grep -c . ) configs) =="
for cfg in $CFGS; do
  # skip extends-only base configs with no own inputs
  hasinput=$(python3 -c "import json;d=json.load(open('$cfg'));print(1 if (d.get('include') or d.get('files')) else 0)" 2>/dev/null || echo 1)
  [ "$hasinput" = "0" ] && continue
  out=$("$TSC" --noEmit -p "$cfg" 2>&1)
  errs=$(printf '%s' "$out" | grep -cE "error TS")
  if printf '%s' "$out" | grep -q "TS18003"; then          # "No inputs were found" = stale config for empty dir
    echo "EMPTY  $cfg  (stale config — no input files)"; empty=$((empty+1)); continue
  fi
  ran=$((ran+1))
  if [ "$errs" -eq 0 ]; then
    echo "ok     $cfg"
  else
    echo "FAIL   $cfg  ($errs errors)"
    printf '%s\n' "$out" | grep -E "error TS" | head -3 | sed 's/^/         /'
    fail=1
  fi
done

echo ""
echo "swept ${ran} configs; ${empty} stale-empty"
[ "$fail" -eq 0 ] && echo "✓ typecheck:all green" || echo "✗ typecheck:all — failures above (deleted-API imports / drift in test/example files)"
exit "$fail"
