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

tier rag http-client analytics-sdk eval widget                                             # T0 leaves
tier core                                                                                  # T1 hub
tier cli fs skills commerce trace-ui                                                       # T2 (need core)
tier tools messaging                                                                       # T2 (need core/rag)
tier rag-loaders lancedb-store postgres-store redis-store upstash-store \
     vectorize-store hono-server cf-agent messaging-meta engagement                        # T3 (need core/rag/tools)
# (LiveKit voice/telephony extracted to kuralle/kuralle-livekit; provider-native
#  voice — realtime-audio, voice-protocol, ws-bench — removed entirely.)
# (no T6 tier: `studio` was dropped in the rebrand and `e2e-tests` has no build step)
echo "✓ all packages built (ordered)"
