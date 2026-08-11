#!/usr/bin/env bash
# Type-check every app under one or more roots, so demo and example apps can no
# longer rot silently.
#
# The framework sweep (typecheck-tsconfigs.sh) only scans packages/. Apps drifted
# out of CI: apps/playground got its own sweep, but apps/examples was covered by a
# single hardcoded entry (marketing-team) while eleven sibling apps went unchecked.
# One parameterised sweep replaces both, so the two cannot diverge again.
#
# Apps carry independent dep trees (react/next/vite/wrangler), so this is a
# SEPARATE sweep from the framework gate — but it IS wired into `typecheck:all`.
#
# An app with NO tsconfig is reported as UNSWEPT rather than passed over in
# silence. That is the failure this script exists to prevent, and a sweep that
# says "green" while seeing nothing is worse than no sweep at all.
#
# Usage: bash scripts/typecheck-apps.sh apps/playground [apps/examples ...]
set -uo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <app-root> [<app-root> ...]" >&2
  exit 2
fi

TSC=./node_modules/.bin/tsc
[ -x "$TSC" ] || TSC=packages/core/node_modules/.bin/tsc

fail=0
total_ran=0
total_empty=0
unswept=()

for root in "$@"; do
  [ -d "$root" ] || { echo "skip   $root (no such directory)"; continue; }

  CFGS=$(find "$root" -name "tsconfig*.json" \
      -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/.next/*" 2>/dev/null \
    | sort)

  echo "== $root tsconfig sweep ($(printf '%s\n' "$CFGS" | grep -c .) configs) =="

  for cfg in $CFGS; do
    # Skip extends-only base configs: they have no inputs of their own.
    hasinput=$(python3 -c "import json;d=json.load(open('$cfg'));print(1 if (d.get('include') or d.get('files')) else 0)" 2>/dev/null || echo 1)
    [ "$hasinput" = "0" ] && { echo "base   $cfg"; continue; }

    out=$("$TSC" --noEmit -p "$cfg" 2>&1)
    if printf '%s' "$out" | grep -q "TS18003"; then
      echo "EMPTY  $cfg  (stale config — no input files)"
      total_empty=$((total_empty + 1))
      continue
    fi

    errs=$(printf '%s' "$out" | grep -cE "error TS")
    total_ran=$((total_ran + 1))
    if [ "$errs" -eq 0 ]; then
      echo "ok     $cfg"
    else
      echo "FAIL   $cfg  ($errs errors)"
      printf '%s\n' "$out" | grep -E "error TS" | head -5 | sed 's/^/         /'
      fail=1
    fi
  done

  # An app directory holding TypeScript but no tsconfig is invisible to the loop
  # above. Name it, or the sweep reports green over code it never compiled.
  for appdir in "$root"/*/; do
    [ -d "$appdir" ] || continue
    ls "$appdir"tsconfig*.json >/dev/null 2>&1 && continue
    tscount=$(find "$appdir" \( -name '*.ts' -o -name '*.tsx' \) -not -path "*/node_modules/*" 2>/dev/null | grep -c .)
    [ "$tscount" -gt 0 ] && unswept+=("${appdir%/} (${tscount} .ts files, no tsconfig)")
  done
done

echo ""
echo "swept ${total_ran} configs; ${total_empty} stale-empty"

if [ "${#unswept[@]}" -gt 0 ]; then
  echo ""
  echo "UNSWEPT — TypeScript with no tsconfig, so nothing type-checked it:"
  printf '  %s\n' "${unswept[@]}"
  echo "  Add a tsconfig.json to each, or delete the app if it is dead."
fi

echo ""
[ "$fail" -eq 0 ] && echo "✓ typecheck:apps green" || echo "✗ typecheck:apps — an app drifted (fix it or remove the stale app)"
exit "$fail"
