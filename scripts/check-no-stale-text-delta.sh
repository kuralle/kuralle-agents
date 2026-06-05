#!/usr/bin/env bash
# Publish guard: no publishable source/docs may use the removed 0.3.x text-delta
# shape ({ type: 'text-delta', text }) or read .text when handling text-delta events.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

exclude='/(test|tests|__tests__|\.handoff|dist|node_modules)/'

report() {
  local label="$1"
  local hits="$2"
  if [ -n "$hits" ]; then
    echo "✗ ${label}:"
    printf '%s\n' "$hits" | sed 's/^/    /'
    fail=1
  fi
}

# Stale constructor: { type: 'text-delta', text: ... }
constructor_hits="$(grep -rnE "type:[[:space:]]*['\"]text-delta['\"][[:space:]]*,[[:space:]]*text" \
  "$ROOT"/packages/*/src 2>/dev/null | grep -Ev "$exclude" || true)"
report "stale text-delta constructor in package src" "$constructor_hits"

# Shipped guides must use part.delta (R-02 class)
guide_hits="$(grep -rn "part\.text" "$ROOT"/packages/*/guides 2>/dev/null || true)"
report "part.text in shipped guides" "$guide_hits"

# Single-line stream consumers reading .text on text-delta (not AI SDK yield { delta: part.text })
consumer_re='(part|event|data)\.type === ['\''"]text-delta['\''"][^;{]*(part|event|data)\.text'
consumer_dirs=(
  "$ROOT"/apps/docs
  "$ROOT"/docs/skills
  "$ROOT"/README.md
)
for pkg_readme in "$ROOT"/packages/*/README.md; do
  [ -f "$pkg_readme" ] && consumer_dirs+=("$pkg_readme")
done

consumer_hits=""
for path in "${consumer_dirs[@]}"; do
  [ -e "$path" ] || continue
  found="$(grep -rnE "$consumer_re" "$path" 2>/dev/null | grep -Ev "$exclude" || true)"
  if [ -n "$found" ]; then
    consumer_hits+="${found}"$'\n'
  fi
done
report "stale text-delta .text consumer in docs/READMEs" "${consumer_hits%$'\n'}"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Refusing: migrate text-delta consumers to part.delta and lifecycle events (text-start/text-end)."
  exit 1
fi

echo "✓ no stale text-delta .text reads or constructors in publishable files"
