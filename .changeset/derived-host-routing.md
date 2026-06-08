---
"@kuralle-agents/core": major
"@kuralle-agents/hono-server": major
"@kuralle-agents/tools": major
"@kuralle-agents/rag": major
"@kuralle-agents/eval": major
"@kuralle-agents/realtime-audio": major
"@kuralle-agents/livekit-plugin": major
"@kuralle-agents/livekit-plugin-transport-ws": major
"@kuralle-agents/livekit-plugin-transport-http": major
"@kuralle-agents/livekit-plugin-transport-sip": major
"@kuralle-agents/livekit-plugin-transport-smartpbx": major
"@kuralle-agents/livekit-plugin-transport-twilio": major
"@kuralle-agents/cf-agent": major
"@kuralle-agents/redis-store": major
"@kuralle-agents/postgres-store": major
"@kuralle-agents/analytics-sdk": major
"@kuralle-agents/widget": major
"@kuralle-agents/messaging": major
"@kuralle-agents/messaging-meta": major
"@kuralle-agents/engagement": major
---

# Derived host routing (breaking)

## Removed

- `routing.mode`, `routing.always`, and `routing.default` from `RoutingPolicy` — no public routing mode enum.
- Lexical/deterministic routing (`deterministicRouteMatch`, `keywordRouteFallback`) from the hot path.
- `Flow.hybrid` / `FlowDetourRules` (removed in v2 reset; docs updated).

## Added / changed

- **Derived routing:** behavior follows agent shape — answering agents (`instructions`/`flows`/tools) fold `enter_flow` and `transfer_to_agent` into the speaking turn; pure dispatchers (`routes`/`agents`/`handoffs` without an answering surface) classify silently with no user-facing prose.
- **Lazy host-control guard:** the classifier runs only when an answering turn ends with no control tool and no substantive text (not on every answered turn). Emits `host-guard` telemetry custom events.
- **`routing.dispatch?: 'strict'`** — optional compliance override for controlled-TTS / text channels (buffer until answer intent is known).
- **`routing.model`** — still configures the control-reasoning model for the lazy guard and pure-dispatcher classifier.

## Migration

1. **Delete `routing.mode`** — do not set `'tools'`, `'structured'`, or `'llm'`. Populate `flows`, `routes`, `agents`, and `instructions` instead; the runtime derives behavior.
2. **Delete `routing.always` and `routing.default`** — model a fallback as a normal semantic route/child agent (e.g. a "general support" target), not a config default.
3. **Routes-only agents** become silent pure dispatchers (no fallback prose). Add `instructions` or a child route if the agent must speak before routing.
4. **Host-control tools** — answering agents with multiple flows or transfer targets receive `enter_flow` / `transfer_to_agent` automatically; call them instead of routing prose.
5. **Internal API:** the `HostControlContext.guard` field is removed — drivers no longer own the guard. `HostControlContext` carries only `dispatchMode`/`advisoryDispatch`; the host loop is the sole guard owner and invokes the classifier only on empty no-control turns (framework-internal; no consumer action unless you extended drivers).

## Affected packages

All packages in the fixed release group (`@kuralle-agents/core` and dependents listed in `.changeset/config.json`).
