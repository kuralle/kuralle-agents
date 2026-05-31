#!/usr/bin/env bash
# Publish guard: no package tarball may contain a source map (*.map) or raw
# TypeScript source (src/**). A shipped .map de-minifies published code back
# to original source — the exact leak we refuse to repeat. Runs after build,
# before `pnpm publish -r` (see the `changeset:publish` script).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

for pkg in "$ROOT"/packages/*/package.json; do
  dir="$(dirname "$pkg")"
  name="$(node -e "process.stdout.write(require('$pkg').name||'')" 2>/dev/null || basename "$dir")"
  private="$(node -e "process.stdout.write(String(!!require('$pkg').private))" 2>/dev/null || echo false)"
  [ "$private" = "true" ] && continue

  files="$(cd "$dir" && npm pack --dry-run --json 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write((j[0].files||[]).map(f=>f.path).join('\n'))}catch(e){}})")"

  offenders="$(printf '%s\n' "$files" | grep -E '\.map$|^src/' || true)"
  if [ -n "$offenders" ]; then
    echo "✗ ${name} would publish source-leaking files:"
    printf '%s\n' "$offenders" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Refusing to publish. Remove .map / raw src from the tarball — fix the build (drop --sourcemap / sourceMap) or the package 'files' field."
  exit 1
fi
echo "✓ no source maps or raw src in any publishable package tarball"
