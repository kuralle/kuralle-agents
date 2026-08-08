#!/usr/bin/env bash
# Provenance gate. Kuralle is Apache-2.0 and reimplements design from named peer
# sources (ADR-0016 §C: reimplement from named source, never paste). This enforces
# the three things that can silently rot:
#
#   1. No file may cite an AGPL source as its origin. coder/mux is AGPL-3.0 and its
#      network clause would reach our entire distribution, so it is read-only —
#      copy nothing, cite nothing.
#   2. Every in-file "Reimplemented from `<project>`" credit must have a matching
#      licence file, so a credit cannot name a source we never licensed.
#   3. licenses/ and THIRD_PARTY_LICENSES.md must agree in both directions, so
#      neither a stray licence file nor an unbacked index row survives.
#
# Apache-2.0 §4(d) additionally requires stating that changes were made; an in-file
# note saying "reimplemented from" satisfies it, and rule 2 is what keeps it present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0

report() {
  local label="$1"
  local detail="$2"
  echo "✗ ${label}"
  if [ -n "$detail" ]; then
    printf '%s\n' "$detail" | sed 's/^/    /'
  fi
  fail=1
}

# ── Self-test: prove the AGPL detector can actually fire ─────────────────────────
# Runs FIRST, before any artefact check, so it is reachable whether or not the
# artefacts exist. Same convention as scripts/check-no-raw-tool-execute.sh: a guard
# nobody has watched fail is indistinguishable from a guard that cannot fail.
if [ "${SELFTEST:-0}" = "1" ]; then
  planted='// Reimplemented from `coder/mux`, internal/mcp/manager.go (AGPL-3.0).'
  benign='// coder/mux is AGPL-3.0 and was read-only; nothing here derives from it.'
  if ! printf '%s' "$planted" | grep -qEi 'reimplemented from.*(coder/mux|agpl)'; then
    echo "✗ provenance guard self-test failed — the AGPL detector did not fire"
    exit 1
  fi
  if printf '%s' "$benign" | grep -qEi 'reimplemented from.*(coder/mux|agpl)'; then
    echo "✗ provenance guard self-test failed — the detector flags a benign mention"
    exit 1
  fi
  echo "✓ provenance guard fires on a planted AGPL citation and spares a benign mention"
  exit 0
fi

# Source files we scan for credits. Packages only — apps and playgrounds are not
# published, so they are not part of the distribution this gate protects.
scan_paths() {
  find packages -type f \( -name '*.ts' -o -name '*.tsx' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null || true
}

# ── 1. No AGPL source may be cited as an origin ──────────────────────────────────
# Matches a citation, not a mention: the word has to appear on a line that also
# claims provenance, so a comment explaining *why* mux is off limits does not trip it.
agpl_hits="$(scan_paths | xargs grep -nEi 'reimplemented from.*(coder/mux|agpl)|(ported|adapted|copied) from.*(coder/mux|agpl)' 2>/dev/null || true)"
if [ -n "$agpl_hits" ]; then
  report "a source file cites an AGPL-licensed origin (coder/mux is read-only — copy nothing)" "$agpl_hits"
fi

# ── 2. Required artefacts exist ──────────────────────────────────────────────────
for required in licenses licenses/README.md THIRD_PARTY_LICENSES.md NOTICE; do
  if [ ! -e "$required" ]; then
    report "missing required attribution artefact: $required" ""
  fi
done

# Nothing further is checkable without the index; bail out with what we have.
if [ ! -e THIRD_PARTY_LICENSES.md ] || [ ! -d licenses ]; then
  echo ""
  echo "Refusing: attribution artefacts are incomplete."
  exit 1
fi

# ── 3. licenses/ and the index agree in both directions ──────────────────────────
license_files="$(find licenses -maxdepth 1 -name '*.txt' -exec basename {} \; | sort)"

if [ -z "$license_files" ]; then
  report "licenses/ contains no <spdx>-<project>.txt files" ""
fi

while IFS= read -r lf; do
  [ -z "$lf" ] && continue
  if ! grep -qF "$lf" THIRD_PARTY_LICENSES.md; then
    report "licences/$lf is not indexed in THIRD_PARTY_LICENSES.md" ""
  fi
  # A placeholder is worse than nothing: it looks discharged and is not.
  if [ "$(wc -c < "licenses/$lf")" -lt 200 ]; then
    report "licenses/$lf is too short to be a real licence text" ""
  fi
done <<< "$license_files"

indexed="$(grep -oE 'licenses/[A-Za-z0-9._-]+\.txt' THIRD_PARTY_LICENSES.md | sed 's|licenses/||' | sort -u || true)"
while IFS= read -r ix; do
  [ -z "$ix" ] && continue
  if [ ! -f "licenses/$ix" ]; then
    report "THIRD_PARTY_LICENSES.md indexes licenses/$ix, which does not exist" ""
  fi
done <<< "$indexed"

# ── 4. Every in-file credit names a source we actually licensed ──────────────────
# Credit form: Reimplemented from `<owner>/<project>` or `<package-name>`
credits="$(scan_paths | xargs grep -hoE 'Reimplemented from `[^`]+`' 2>/dev/null \
  | sed -E 's/Reimplemented from `([^`]+)`/\1/' | sort -u || true)"

while IFS= read -r project; do
  [ -z "$project" ] && continue
  # `@scope/name` and `owner/name` both slug to `scope-name` / `owner-name`.
  slug="$(printf '%s' "$project" | sed 's|^@||; s|/|-|g')"
  if ! ls licenses/*"${slug}".txt >/dev/null 2>&1; then
    report "in-file credit names \"$project\" but no licenses/*-${slug}.txt exists" ""
  fi
done <<< "$credits"

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Refusing: provenance is incomplete or cites a forbidden source."
  echo "See the RFC §12 attribution policy and ADR-0016 §C."
  exit 1
fi

echo "✓ provenance: attribution artefacts complete, no AGPL-derived file"
