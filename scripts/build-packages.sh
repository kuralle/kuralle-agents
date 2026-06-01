#!/usr/bin/env bash
# Topologically-ordered package build. `bun run --filter './packages/*' build`
# runs unordered-parallel and races on dist/ (consumers compile before core's
# dist is written), so it fails cold. Build in dependency tiers instead.
# core builds standalone (its config/realtime-audio package deps are not compile
# imports), so there is no build-time cycle.
set -euo pipefail
cd "$(dirname "$0")/.."

tier() {
  echo "── tier: $* ──"
  local args=()
  for p in "$@"; do args+=(--filter "@kuralle-agents/$p"); done
  bun run "${args[@]}" build
}

tier voice-protocol rag http-client analytics-sdk eval widget ws-bench   # T0 leaves
tier core                                                                                  # T1 hub
tier realtime-audio tools messaging                                                        # T2 (need core/rag/voice-protocol)
tier rag-loaders lancedb-store postgres-store redis-store upstash-store \
     vectorize-store hono-server cf-agent livekit-plugin messaging-meta                    # T3 (need core/rag/realtime-audio/tools)
tier transport-base                                                                        # T4
tier livekit-plugin-transport-ws livekit-plugin-transport-sip livekit-plugin-transport-http \
     livekit-plugin-transport-twilio livekit-plugin-transport-smartpbx                     # T5 transports
# (no T6 tier: `studio` was dropped in the rebrand and `e2e-tests` has no build step)
echo "✓ all packages built (ordered)"
