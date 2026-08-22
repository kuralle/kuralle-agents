#!/usr/bin/env bash
# Topologically-ordered package build. `bun run --filter './packages/*' build`
# runs unordered-parallel and races on dist/ (consumers compile before core's
# dist is written), so it fails cold. Build in dependency tiers instead.
# core builds standalone (its config package deps are not compile imports), so
# there is no build-time cycle.
set -euo pipefail
cd "$(dirname "$0")/.."

tier() {
  echo "── tier: $* ──"
  local args=()
  for p in "$@"; do args+=(--filter "@kuralle-agents/$p"); done
  bun run "${args[@]}" build
}

tier http-client analytics-sdk eval widget create-kuralle-agents                          # T0 leaves
tier core                                                                                  # T1 hub
tier fs commerce trace-ui pi-driver rag                                                     # T2 (need core)
tier deployment plugins                                                                    # T3 (need core/fs)
tier mcp                                                                                   # T4 (needs core/plugins)
tier build                                                                                 # T4 (needs core/deployment)
tier tools messaging                                                                       # T2 (need core/rag)
tier rag-loaders lancedb-store postgres-store redis-store upstash-store \
     vectorize-store hono-server cf-agent messaging-meta engagement                        # T3 (need core/rag/tools)
tier cli                                                                                   # T5 (needs build/deployment/hono-server)
# (LiveKit voice/telephony extracted to kuralle/kuralle-livekit; provider-native
#  voice — realtime-audio, voice-protocol, ws-bench — removed entirely.)
# (no T6 tier: `studio` was dropped in the rebrand and `e2e-tests` has no build step)
# Every package with a `build` script must appear in a tier above. The tier list is
# hand-maintained and has silently omitted packages twice: `rag` was left in T0 after it
# gained a core import (a cold tree then failed to build), and `mcp`/`plugins` were never
# listed at all, so their dist was missing on any machine that had not built them by hand.
# Derive the expected set from the packages themselves rather than from a second list, or
# this check cannot notice what the list omits.
# Every package with a `build` script must appear in a tier above. The tier list is
# hand-maintained and has silently omitted packages twice: `rag` sat in T0 after it gained a
# core import, so a cold tree failed to build; `mcp` and `plugins` were never listed at all,
# so their dist was missing on any machine that had not built them by hand. Derive the
# expected set from the packages themselves — a check that compares the list to a second
# hand-written list cannot notice what both omit.
missing="$(node -e '
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(process.argv[1], "utf8").replace(/\\\r?\n/g, " ");
const tiers = new Set(
  src.split("\n").filter((l) => l.startsWith("tier "))
     .flatMap((l) => l.replace(/#.*/, "").trim().split(/\s+/).slice(1)),
);
const miss = fs.readdirSync("packages").filter((pkg) => {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join("packages", pkg, "package.json"), "utf8")).scripts?.build);
  } catch { return false; }
}).filter((pkg) => !tiers.has(pkg));
process.stdout.write(miss.join(" "));
' "$0")"
if [ -n "$missing" ]; then
  echo "✗ buildable package(s) missing from every tier in $0: $missing" >&2
  exit 1
fi

echo "✓ all packages built (ordered)"
