# Understanding: text-delta consumer/producer blast-radius map

## Frame

Enables scoping the S1-01 brief with an exhaustive file:line list of every site that must change when `{ type: 'text-delta'; text: string }` is removed from `HarnessStreamPart` (stream union, `types/stream.ts:11`) and the voice union (`types/voice.ts:266`) and replaced with the four-variant lifecycle `text-start{id}` / `text-delta{id,delta}` / `text-end{id}` / `text-cancel{id,reason}` (RFC §4.1–4.2, REQ-6/7). No compat layer (REQ-11). Every in-repo producer and consumer must be updated in the same change so `typecheck:all` remains green.

## Primitive (first principles)

Two structurally-similar `text-delta` union members — `stream.ts:11` and `voice.ts:266` — whose `.text` field is both the emitter's payload and the consumer's content-accessor. Removal breaks every exhaustive switch, every `.text` read, and every `{ type: 'text-delta', text: ... }` literal. The new protocol carries `id` (per-turn UUID) and `delta` (per-chunk string) instead, plus start/end/cancel lifecycle framing.

## Top-down map

### System boundary
Kuralle runtime (`Runtime.ts`) → `RunContext.emit()` accepts `HarnessStreamPart` from `types/stream.ts` → `EventBus` (`TurnHandle.ts`) → consumers via `AsyncIterable<HarnessStreamPart>`.

### Layers (inward from external consumers)

**Layer 1 — Transport adapters (SSE/HTTP/WS)**
- `kuralle-hono-server/src/index.ts` — SSE serializer (generic `sendSSEPart`, line 246), chat/flow endpoints that read `part.text` (`:231`, `:395`, `:828`, `:911`), widget WebSocket that constructs `text-delta` JSON (`:648`, `:687`). Confidence: **high**.
- `kuralle-hono-server/src/openaiCompat.ts` — OpenAI-compatible SSE mapper; reads `part.text` at `:280-281` (tool-acc path) and `:411-414` (streaming path). Confidence: **high**.
- `kuralle-hono-server/src/streamFilter.ts` — `SAFE_EVENT_TYPES` set includes `'text-delta'` at `:4`; must add lifecycle variant names. Confidence: **high**.
- `kuralle-cf-agent/src/StreamAdapter.ts` — SSE adapter for CF; reads `part.text` at `:83`, maps to CF's `{ type: 'text-delta', delta: ... }` SSE wire shape. Already outputs new SSE shape; only the *input* read must change from `.text` → `.delta`. Confidence: **high**.

**Layer 2 — Client libraries**
- `kuralle-widget/src/client/WidgetClient.ts` — reads `data.text` at `:213,222` to construct UIMessage parts. Confidence: **high**.
- `kuralle-messaging/src/adapter/stream-mapper.ts` — reads `part.text` at `:49` into `textBuffer`. Confidence: **high**.
- `kuralle-messaging/src/stream-filter.ts` — type guard `textDelta` matches `'text-delta'` at `:6`. Confidence: **high**.

**Layer 3 — Cascaded voice adapter (deferred true streaming)**
- `kuralle-livekit-plugin/src/llm/KuralleRuntimeLLMAdapter.ts` — reads `part.text` at line ~208, pushes to LiveKit TTS queue. S1-01: compile-only (keep buffered behavior). Sprint 3 handles `text-delta.delta` and lifecycle. Confidence: **high**.
- `kuralle-livekit-plugin/src/metrics/types.ts` — doc comments mention `text-delta` at `:19,:33`; no code change needed (comments only). Confidence: **high**.

**Layer 4 — Runtime-internal consumers (hooks)**
- `kuralle-core/src/foundation/DefaultConversationEventLog.ts` — reads `part.text` at `:48` for `ASSISTANT_TEXT_KEY` accumulation. Confidence: **high**.
- `kuralle-core/src/eval/EvalRunner.ts` — reads `part.text` at `:34` for text scoring. Confidence: **high**.
- `kuralle-core/src/hooks/builtin/observability.ts` — receives `HarnessStreamPart` (voice union); does NOT match `'text-delta'` in its switch, only `flow-transition` and generic types. PASSTHROUGH — no `.text` access. Typecheck-only risk from union change. Confidence: **high**.
- `kuralle-core/src/hooks/builtin/metrics.ts` — only matches `'custom'` parts. PASSTHROUGH. Confidence: **high**.
- `kuralle-core/src/hooks/HookRunner.ts` — delegates to `HarnessHooks.onStreamPart`; no direct `text-delta` access. Confidence: **high**.

**Layer 5 — Producers (emit sites)**
- `TextDriver.ts:58` — blocked pre-turn: `ctx.emit({ type: 'text-delta', text: blocked })`
- `TextDriver.ts:136` — normal turn-end: `ctx.emit({ type: 'text-delta', text: emitText })`
- `VoiceDriver.ts:52` — blocked pre-turn: `ctx.emit({ type: 'text-delta', text: blocked })`
- `VoiceDriver.ts:90` — interrupt truncation: `ctx.emit({ type: 'text-delta', text: out.text })`
- `VoiceDriver.ts:105` — normal turn-end: `ctx.emit({ type: 'text-delta', text: emitText })`
- `Runtime.ts:131` — `onInterim` tool feedback: `emit({ type: 'text-delta', text: message })`
- `Runtime.ts:246` — degraded error: `emit({ type: 'text-delta', text: SAFE_DEGRADED_MESSAGE })`
- `collectDigression.ts:125` — digression answer: `ctx.emit({ type: 'text-delta', text: turn.text })`
- `collectUntilComplete.ts:149` — collect ask: `ctx.emit({ type: 'text-delta', text })`
- `degrade.ts:22` — degraded fallback: `ctx.emit({ type: 'text-delta', text })`
- `hono-server/src/index.ts:648,687` — widget WebSocket constructs `text-delta` JSON strings (PRODUCER, not consumer)

**Layer 6 — Generic serializers (PASSTHROUGH)**
- `TurnHandle.ts:88-92` — SSE/ndjson: `JSON.stringify(part)` — generic; no `.text` access. No change needed.

**Layer 7 — Union definitions (root cause of blast radius)**
- `types/stream.ts:11` — `HarnessStreamPart` (authoritative runtime union, exported at `index.ts:271`)
- `types/voice.ts:266` — Voice union `HarnessStreamPart` (used by `HarnessHooks.onStreamPart` via `types/runtime.ts:5`)

## Bottom-up trace

### Atomic unit: `{ type: 'text-delta'; text: string }`

Definition sites:
1. `types/stream.ts:11` — member of `HarnessStreamPart` (7th variant in the union)
2. `types/voice.ts:266` — member of voice-union `HarnessStreamPart` (2nd variant after `input`)
3. `types/processors.ts:92` — member of `AgentStreamPart` (1st variant)

### Caller chain (stream.ts union):

`ctx.emit()` accepts `HarnessStreamPart` from `stream.ts` (`run-context.ts:6`).

**Emit sites → `ctx.emit()`:**
```
TextDriver.runAgentTurn (:58 blocked, :136 normal)
VoiceDriver.runAgentTurn (:52 blocked, :90 interrupt, :105 normal)
Runtime.run (:131 onInterim, :246 degraded)
collectDigression (:125)
collectUntilComplete (:149)
degrade (:22)
```

**`ctx.emit()` → `EventBus.emit()` → `EventBus.events()` AsyncIterable → consumers:**
```
TurnHandle.events (external)
HarnessHooks.onStreamPart (internal — voice union)
DefaultConversationEventLog.record (:45-48) — voice union
```

**Consumers reading `.text`:**
All downstream adapters, hooks, tests, examples.

### Caller chain (voice union):

`HarnessHooks.onStreamPart` uses the voice union's `HarnessStreamPart` (`types/runtime.ts:5` → `./voice.js`). This is invoked by `HookRunner.onStreamPart` → called at `Runtime.ts:101` for every event emitted via `ctx.emit()`.

The voice union is a superset of the stream.ts union (structurally compatible — `ctx.emit()` from `stream.ts` union is call-compatible with both). All emit sites produce events compatible with both unions.

### Invariants:
- `ctx.emit()` events always match `HarnessStreamPart` from `stream.ts`
- VoiceDriver's emit path is identical (uses `ctx.emit()`, not a separate union)
- `extractionTurn.ts` confirms "extraction never speaks" — no `text-delta` emitted from extraction path (REQ-12)
- `eventBus.emit()` is synchronous (line 32) — consumers wake on same tick

## Reconciliation

### Agreements (top-down × bottom-up)

| Claim | Top-down says | Bottom-up confirms | Confidence |
|-------|--------------|-------------------|------------|
| Two unions, not one | stream.ts + voice.ts | `stream.ts:11`, `voice.ts:266` | **high** |
| `ctx.emit()` uses stream.ts union | `run-context.ts:6` | All emit sites call `ctx.emit()` | **high** |
| Voice driver emit → stream.ts union | VoiceDriver calls `ctx.emit()` | Compatible via structural typing | **high** |
| SSE serializer generic | `JSON.stringify(part)` | `TurnHandle.ts:88-92` | **high** |
| extractionTurn emits no text-delta | Comment + code | `extractionTurn.ts:46` skips text-delta | **high** |
| Cascaded adapter reads `.text` | `KuralleRuntimeLLMAdapter.ts:208-219` | `part.text` read + `part.type !== 'text-delta'` filter | **high** |

### Divergences

**AgentStreamPart status:**
- **Top-down says:** only `stream.ts` and `voice.ts` are named (RFC §4.1–4.2). `AgentStreamPart` is NOT in scope.
- **Bottom-up says:** `AgentStreamPart` (`processors.ts:92`) defines a `text-delta` member used by `Hook.onStreamPart` (`runtime.ts:30`). It is a separate public API contract.
- **Hypothesis:** `Hook.onStreamPart` is a legacy/separate callback surface. It is NOT part of the live emit path (`ctx.emit()` does not use it). The `HarnessHooks.onStreamPart` (voice union, `runtime.ts:81`) is the runtime-level path. Keeping `AgentStreamPart` unchanged creates a schema inconsistency between the two hook surfaces.
- **Evidence that would resolve:** check whether any shipped consumer (outside this repo) relies on `Hook.onStreamPart` using `AgentStreamPart` with `text: string`. If no external consumers, the two `onStreamPart` hooks were always separate and `AgentStreamPart` can stay as-is (legacy) or be updated for consistency.
- **Recommendation:** Flag as open question for the manager. The minimal safe approach for S1-01 is to update it (add `streamGranularity` is already there) — it adds ~10 extra lines to S1-01. The conservative approach is to leave it and note the inconsistency in the CHANGELOG.

**Voice union `HarnessStreamPart` re-export path:**
- `types/index.ts:9` re-exports everything from `voice.js` — this means `HarnessStreamPart` from the voice union is also accessible via the types barrel.
- Internal hooks (`observability.ts`, `metrics.ts`) import `HarnessStreamPart` from `types/index.js` → resolves to voice.ts union.
- External packages (`kuralle-cf-agent`, `kuralle-livekit-plugin`, etc.) import `HarnessStreamPart` from `@kuralle-agents/core` → resolves to `index.ts:271` → `stream.ts` union.

**This is correct for S1-01:** the external-package `HarnessStreamPart` (stream.ts) and the internal-hook `HarnessStreamPart` (voice.ts) are intentionally different. Both have `text-delta` members. Both must change. The typecheck will catch any consumer that accesses `.text` on either.

## Classification table

Total files: **86** (grep for `text-delta`, excluding `/dist/`).

### PRODUCER-migrate — emits `{ type: 'text-delta', text: ... }` via `ctx.emit()`

| # | File | Line(s) | What changes |
|---|------|---------|-------------|
| P1 | `packages/kuralle-core/src/runtime/channels/TextDriver.ts` | `:58` | Blocked pre-turn: `emit({ type: 'text-start', id: turnId })` → `emit({ type: 'text-delta', id: turnId, delta: blocked })` → `emit({ type: 'text-end', id: turnId })` |
| P2 | `packages/kuralle-core/src/runtime/channels/TextDriver.ts` | `:136` | Normal emit: same three-event lifecycle for `emitText` |
| P3 | `packages/kuralle-core/src/runtime/channels/VoiceDriver.ts` | `:52` | Blocked pre-turn: same lifecycle as P1 |
| P4 | `packages/kuralle-core/src/runtime/channels/VoiceDriver.ts` | `:90` | Interrupt truncation: same lifecycle + `text-cancel` if partial emit precedes |
| P5 | `packages/kuralle-core/src/runtime/channels/VoiceDriver.ts` | `:105` | Normal emit: same lifecycle |
| P6 | `packages/kuralle-core/src/runtime/Runtime.ts` | `:131` | `onInterim` tool feedback: `emit({ type: 'text-start', id: interimId }); emit({ type: 'text-delta', id: interimId, delta: message }); emit({ type: 'text-end', id: interimId })` |
| P7 | `packages/kuralle-core/src/runtime/Runtime.ts` | `:246` | Degraded error message: same lifecycle for `SAFE_DEGRADED_MESSAGE` |
| P8 | `packages/kuralle-core/src/flow/collectDigression.ts` | `:125` | Digression answer: lifecycle for `turn.text` + `turn-end` after |
| P9 | `packages/kuralle-core/src/flow/collectUntilComplete.ts` | `:149` | Collect ask: lifecycle for `text` + `turn-end` after |
| P10 | `packages/kuralle-core/src/flow/degrade.ts` | `:22` | Degraded fallback: lifecycle for `text` |
| P11 | `packages/kuralle-hono-server/src/index.ts` | `:648` | Widget welcome: `JSON.stringify({ type: 'text-delta', id: ..., delta: staticWelcome })` |
| P12 | `packages/kuralle-hono-server/src/index.ts` | `:687` | Widget error fallback: same shape change |

### CONSUMER-migrate — reads `part.text` / matches `'text-delta'`

| # | File | Line(s) | What changes |
|---|------|---------|-------------|
| C1 | `packages/kuralle-core/src/foundation/DefaultConversationEventLog.ts` | `:45-48` | `part.text` → `part.delta`; needs id tracking for multi-delta accumulation (currently concatenates all per session; still valid with new protocol) |
| C2 | `packages/kuralle-core/src/eval/EvalRunner.ts` | `:33-34` | `part.text` → `part.delta` (accumulate `response += part.delta`) |
| C3 | `packages/kuralle-hono-server/src/index.ts` | `:231-232` | `collectResponse`: `part.text` → `part.delta` |
| C4 | `packages/kuralle-hono-server/src/index.ts` | `:395-396` | `text/plain` stream: `part.text` → `part.delta` |
| C5 | `packages/kuralle-hono-server/src/index.ts` | `:828-829` | `collectFlowResponse`: `part.text` → `part.delta` |
| C6 | `packages/kuralle-hono-server/src/index.ts` | `:911-912` | Flow stream: `part.text` → `part.delta` |
| C7 | `packages/kuralle-hono-server/src/openaiCompat.ts` | `:280-281` | Tool-acc path: `part.text` → `part.delta` |
| C8 | `packages/kuralle-hono-server/src/openaiCompat.ts` | `:411-414` | Streaming path: `part.text` → `part.delta` (3 lines) |
| C9 | `packages/kuralle-hono-server/src/streamFilter.ts` | `:4` | `SAFE_EVENT_TYPES` set: add `'text-start'`, `'text-end'`, `'text-cancel'` (keep `'text-delta'`) |
| C10 | `packages/kuralle-cf-agent/src/StreamAdapter.ts` | `:78-83` | `case 'text-delta'`: `delta: part.text` → `delta: part.delta` |
| C11 | `packages/kuralle-widget/src/client/WidgetClient.ts` | `:201-222` | `data.text` → `data.delta`; handle `data.type === 'text-start'` / `'text-end'` (new content tracking) |
| C12 | `packages/kuralle-messaging/src/adapter/stream-mapper.ts` | `:48-49` | `part.text` → `part.delta` |
| C13 | `packages/kuralle-messaging/src/stream-filter.ts` | `:6` | Type guard: predicate stays `p.type === 'text-delta'` (type name unchanged); return type `Part<'text-delta'>` now has `{ id: string; delta: string }` |

### OUT-OF-SCOPE / deferred — compile-only in S1-01

| # | File | Line(s) | What changes |
|---|------|---------|-------------|
| D1 | `packages/kuralle-livekit-plugin/src/llm/KuralleRuntimeLLMAdapter.ts` | `:208-219` | `part.text` → `part.delta`; add `text-start`/`text-end`/`text-cancel` handling (REQ-10). In S1-01: **compile-only** — change `.text` → `.delta` but keep buffered behavior; true streaming deferred to Sprint 3. |
| D2 | `packages/kuralle-livekit-plugin/src/metrics/types.ts` | `:19,:33` | Comment-only references to `text-delta` — update comments, no type changes needed. |

### PASSTHROUGH-nochange — serializes generically, no `.text` access

| # | File | Reason |
|---|------|--------|
| G1 | `packages/kuralle-core/src/events/TurnHandle.ts:88-92` | `JSON.stringify(part)` — generic; new shapes serialize transparently |
| G2 | `packages/kuralle-core/src/hooks/builtin/observability.ts:515` | Receives `HarnessStreamPart` (voice union); only matches `flow-transition` and generic types; no `.text` access |
| G3 | `packages/kuralle-core/src/hooks/builtin/metrics.ts:61` | Only matches `'custom'` parts; no `.text` access |
| G4 | `packages/kuralle-core/src/hooks/HookRunner.ts:114-115` | Delegates to `HarnessHooks.onStreamPart`; no direct `.text` access |
| G5 | `packages/kuralle-core/src/outcomes/streamPart.ts:1-9` | Imports `HarnessStreamPart` from voice.ts but only constructs `conversation-outcome`; no `text-delta` reference |

### TEST/EXAMPLE-update — asserts or constructs old shape

All tests and examples that construct `{ type: 'text-delta', text: '...' }` must switch to `{ type: 'text-delta', id: '...', delta: '...' }` (or emit start/delta/end trio). Those that consume `part.text` switch to `part.delta`.

#### Compile-critical tests (gate `typecheck:all` — MUST update in S1-01):

| # | File | Lines | What changes |
|---|------|-------|-------------|
| T1 | `packages/kuralle-core/test/core-channel/textdriver.test.ts` | `:20,27-28,55-56,82,100,143,182-183` | Constructs/consumes `{ type: 'text-delta', text: ... }` |
| T2 | `packages/kuralle-core/test/core-channel/textdriver.smoke.ts` | `:52-53,57-58` | Reads `part.text` |
| T3 | `packages/kuralle-core/test/core-agent/agent.smoke.ts` | `:81-86,91` | Reads `part.text` |
| T4 | `packages/kuralle-core/test/core-flow/flow.smoke.ts` | `:74-79,95-96` | Reads `part.text` |
| T5 | `packages/kuralle-core/test/core-flow/base-layer.test.ts` | `:22` | Constructs `{ type: 'text-delta', text: 'ok' }` |
| T6 | `packages/kuralle-core/test/core-flow/control-evaluator.test.ts` | `:49,163` | Constructs + filters `text-delta` |
| T7 | `packages/kuralle-core/test/core-flow/digression.test.ts` | `:80,83,216,219` | Reads `(p as { text?: string }).text` |
| T8 | `packages/kuralle-core/test/core-flow/interactive-stream-part.test.ts` | `:15,43` | Exhaustive switch over union; constructs old shape |
| T9 | `packages/kuralle-core/test/core-flow/recovery-boundary.test.ts` | `:58,126,137,167` | Reads `text` |
| T10 | `packages/kuralle-core/test/core-flow/runFlow.test.ts` | `:124` | Reads `text` |
| T11 | `packages/kuralle-core/test/core-policy/guardrails.test.ts` | `:27,53-54,63,65,75,103-104,115` | Constructs + reads `text` |
| T12 | `packages/kuralle-core/test/core-policy/approval.smoke.ts` | `:136-137` | Filters + maps `part.text` |
| T13 | `packages/kuralle-core/test/core-validation/confidence-gate.test.ts` | `:35,125-126,307-308` | Constructs + reads `text` |
| T14 | `packages/kuralle-core/test/core-grounding/extraction.test.ts` | `:146,195` | Reads `(p as { text?: string }).text` |
| T15 | `packages/kuralle-core/test/core-grounding/knowledge.test.ts` | `:32` | Constructs old shape |
| T16 | `packages/kuralle-core/test/core-grounding/knowledge.smoke.ts` | `:51-52` | Reads `part.text` |
| T17 | `packages/kuralle-core/test/core-grounding/memory.test.ts` | `:34` | Constructs old shape |
| T18 | `packages/kuralle-core/test/core-tools/tool-interim-timeout.test.ts` | `:18,32,38-39,52,57` | Constructs + reads `text` |
| T19 | `packages/kuralle-core/test/core-voice/conformance.test.ts` | `:110,255,270` | Constructs old shape; reads `turn.text` (TurnResult, not HarnessStreamPart — but line 255,270 construct text-delta) |
| T20 | `packages/kuralle-core/test/core-voice/realtime.smoke.ts` | `:174-175,184` | Filters + maps `part.text` |
| T21 | `packages/kuralle-core/test/core-control/control-model.test.ts` | `:158,294` | Comment + constructs old shape |
| T22 | `packages/kuralle-core/test/core-parity/voice-text-parity.test.ts` | `:80,106,167` | Constructs old shapes |
| T23 | `packages/kuralle-hono-server/test/openai-compat-channel.test.ts` | `:10,33` | Constructs old shape |
| T24 | `packages/kuralle-hono-server/test/openai-compat.auth.test.ts` | `:7` | Constructs old shape |
| T25 | `packages/kuralle-hono-server/test/openai-compat.conformance.test.ts` | `:11,53` | Constructs old shape |
| T26 | `packages/kuralle-hono-server/test/openai-compat.sse-shape.test.ts` | `:9-10,108` | Constructs old shape |
| T27 | `packages/kuralle-hono-server/test/resume-http.test.ts` | `:14` | Constructs old shape |
| T28 | `packages/kuralle-hono-server/test/sse.smoke.ts` | `:31,59,63` | Constructs + reads `text` |
| T29 | `packages/kuralle-livekit-plugin/test/aria_runtime_llm_adapter.test.ts` | `:41,67,90,167` | Constructs old shape |
| T30 | `packages/kuralle-livekit-plugin/test/aria_runtime_llm_adapter_terminus.test.ts` | `:6,68,70-71,83,108,151,154,160,180` | Constructs old shape + doc strings |
| T31 | `packages/kuralle-livekit-plugin/test/kuralle_voice_session_identity.test.ts` | `:15` | Constructs old shape |
| T32 | `packages/kuralle-messaging/test/consent-stop.test.ts` | `:59` | Constructs old shape |
| T33 | `packages/kuralle-messaging/test/ownership-gate.test.ts` | `:72` | Constructs old shape |
| T34 | `packages/kuralle-messaging/test/stream-filter.test.ts` | `:6,8,14-15` | Constructs + reads `part.text` |
| T35 | `packages/kuralle-messaging/test/unhappy-paths.test.ts` | `:100,104,109,346,409,425,437` | Constructs old shape |
| T36 | `packages/kuralle-messaging/test/window-guard.test.ts` | `:130` | Constructs old shape |
| T37 | `packages/kuralle-engagement/test/broadcast.test.ts` | `:188` | Constructs old shape |
| T38 | `packages/kuralle-engagement/test/engagement.test.ts` | `:119` | Constructs old shape |
| T39 | `packages/kuralle-engagement/test/simulator.test.ts` | `:84,156` | Constructs old shape |
| T40 | `packages/kuralle-engagement/examples/booking/booking.test.ts` | `:279,288` | Constructs old shape |
| T41 | `packages/kuralle-e2e-tests/tests/cascaded-flow-text-only-diagnostic.ts` | `:120` | Reads `p.text` |

#### Already using new shape (no S1-01 change):

| # | File | Line | Status |
|---|------|------|--------|
| A1 | `packages/kuralle-e2e-tests/tests/postcall-audit/02-runtime-stream-on-session-end.ts` | `:18` | Uses `{ type: 'text-delta', id, delta: text }` — new shape! |
| A2 | `packages/kuralle-cf-agent/src/voice/__tests__/realtime.test.ts` | `:82` | Uses `{ type: "text-delta", id: "t1", delta: "ok" }` — new shape! |

#### Examples (not compile-gated but referenced by docs — update in S1-01):

| # | File | Lines | Type |
|---|------|-------|------|
| E1 | `packages/kuralle-core/examples/_shared/v2Runner.ts` | `:138` | Reads `part.text` |
| E2 | `packages/kuralle-core/examples/agents/cerebras-interview-agent.ts` | `:143` | Reads `part.text` |
| E3 | `packages/kuralle-core/examples/agents/customer-qa-test/run.ts` | `:108` | Reads `part.text` |
| E4 | `packages/kuralle-core/examples/agents/guardrails-wrapper.ts` | `:118` | Reads `part.text` |
| E5 | `packages/kuralle-core/examples/agents/memory-demo/context-budget.ts` | `:69` | Reads `part.text` |
| E6 | `packages/kuralle-core/examples/agents/memory-demo/form-filler-extraction-with-memory.ts` | `:159` | Reads `part.text` |
| E7 | `packages/kuralle-core/examples/agents/memory-demo/form-filler-with-memory.ts` | `:225` | Reads `part.text` |
| E8 | `packages/kuralle-core/examples/agents/memory-demo/handoff-filters.ts` | `:120` | Reads `part.text` |
| E9 | `packages/kuralle-core/examples/agents/memory-demo/patient-intake-with-memory.ts` | `:198` | Reads `part.text` |
| E10 | `packages/kuralle-core/examples/agents/memory-demo/run.ts` | `:71` | Reads `part.text` |
| E11 | `packages/kuralle-core/examples/agents/memory-demo/validate.ts` | `:75` | Reads `part.text` |
| E12 | `packages/kuralle-core/examples/agents/standalone-agent.ts` | `:33,40,59,96,154,203` | Multiple reads of `part.text` |
| E13 | `packages/kuralle-core/examples/flows/insurance-claims-adversarial.ts` | `:102` | Reads `part.text` |
| E14 | `packages/kuralle-core/examples/flows/kuralle-sink-spike.ts` | `:179` | Reads `part.text` |
| E15 | `packages/kuralle-core/examples/flows/model-matrix-benchmark.ts` | `:59` | Reads `part.text` |
| E16 | `packages/kuralle-core/examples/flows/model-shootout.ts` | `:83` | Reads `part.text` |
| E17 | `packages/kuralle-core/examples/flows/openrouter-benchmark.ts` | `:66` | Reads `part.text` |
| E18 | `packages/kuralle-core/examples/pipeline-verification.ts` | `:67,70-71,80,221` | Filters/reads `text-delta` |
| E19 | `packages/kuralle-core/examples/gemini-reasoning-test.ts` | `:88,90` | Reads `part.text` |
| E20 | `packages/kuralle-core/examples/flows/model-matrix-benchmark.ts` | `:59` | Reads `part.text` |
| E21 | `packages/kuralle-hono-server/examples/flow-server/server.ts` | `:215-216` | Reads `part.text` |
| E22 | `packages/kuralle-redis-store/examples/local-redis/multi-turn.ts` | `:138-139` | Reads `part.text` |

## AgentStreamPart verdict

**Question:** Is `AgentStreamPart` (`types/processors.ts:92-102`) part of the live emit/consume path?

**Answer:** **No.** `AgentStreamPart` is used exclusively by the `Hook` interface's `onStreamPart` callback (`types/runtime.ts:30`). It is a separate, user-facing callback contract. The runtime emit path uses `RunContext.emit()` which accepts `HarnessStreamPart` from `types/stream.ts`.

**Evidence:**
1. `types/runtime.ts:30` — `Hook.onStreamPart?: (ctx: AgentContext, part: AgentStreamPart) => Promise<void>` — uses `AgentStreamPart`
2. `RunContext.emit` (`run-context.ts:56`) — `emit: (part: HarnessStreamPart) => void` — uses stream.ts union, NOT AgentStreamPart
3. The runtime calls hooks via `HarnessHooks.onStreamPart` which uses the *voice union* `HarnessStreamPart` (`runtime.ts:81`), not `AgentStreamPart`
4. Consumers of `AgentStreamPart` (`pipeline-verification.ts:184`, `kuralle-sink-spike.ts:54`) construct test hooks — they don't receive events from `ctx.emit()`

**Is it in S1-01 scope?**

The RFC (§4.1–4.2) names only `types/stream.ts` and `types/voice.ts`. However:
- `AgentStreamPart` is exported via `types/index.ts:3` (re-export of `processors.js`)
- It defines the same `text-delta` shape being removed everywhere else
- Leaving it creates a public API inconsistency: `Hook.onStreamPart` would receive old-shape `{ type: 'text-delta', text: string }` while `HarnessHooks.onStreamPart` receives new-shape `{ type: 'text-delta', id: string, delta: string }`

**Recommendation:** The RFC should be amended to include `AgentStreamPart` in scope, OR the manager should decide to defer it to a separate cleanup. Minimal S1-01 approach: update it (same change as stream.ts/voice.ts) — it's a mechanical change with no consumer impact beyond the two example files that reference it. This adds ~10 lines to S1-01 and prevents the inconsistency.

**Confidence: high** — the emit path and the separate hook contract are clearly documented and the import chain is unambiguous.

## Data & control flow

```
[Model] → streamText().fullStream → TextDriver._runLoop → accumulate draftText
                                                            ↓
                                                    applyPostTurnPolicies
                                                            ↓
                                          ctx.emit({ type: 'text-delta', text: emitText })
                                                            ↓
                                          eventBus.emit(part) → eventBus.events() AsyncIterable
                                                            ↓
                              ┌─────────────────────────────┼──────────────────────────────┐
                              ↓                             ↓                              ↓
                    TurnHandle.events              HarnessHooks.onStreamPart       DefaultConversationEventLog
                    (external stream)              (internal monitoring)           (session workingMemory)
                              ↓
              ┌───────────────┼────────────────┬──────────────────┐
              ↓               ↓                ↓                  ↓
    hono-server SSE    cf-agent SSE    WidgetClient WebSocket   messaging adapter
    (JSON.stringify)   (StreamAdapter) (data.text→UIMessage)   (part.text→buffer)
              ↓               ↓
    LiveKit cascaded   (deferred Sprint 3)
    adapter (part.text
    → TTS queue)
```

**After S1-01 (for text path):**
```
[Model] → streamText().fullStream → speakGated(TokenSource, mode) → text-start + multiple text-delta{id,delta} + text-end
                                                                             ↓
                                                              (same downstream fan-out)
```

## Coupling & dependencies

| Category | What |
|----------|------|
| **Schema/type** | `types/stream.ts`, `types/voice.ts`, `types/processors.ts` — three union definitions (2 in scope, 1 under decision) |
| **Config** | `streamFilter.ts:4` — `SAFE_EVENT_TYPES` set must include lifecycle variants |
| **Cross-package boundary** | 8 packages import `HarnessStreamPart`: `kuralle-core`, `kuralle-hono-server`, `kuralle-cf-agent`, `kuralle-livekit-plugin`, `kuralle-messaging`, `kuralle-widget`, `kuralle-engagement`, `kuralle-e2e-tests` |
| **Wire protocol** | SSE/ndjson bytes: `data: {"type":"text-delta","text":"..."}\n\n` → becomes `data: {"type":"text-delta","id":"...","delta":"..."}\n\n` |
| **Persisted state** | `DefaultConversationEventLog` writes `workingMemory[ASSISTANT_TEXT_KEY]` — accumulation logic unchanged (just field rename) |
| **Cross-process** | External consumers of SSE/HTTP → breaking change communicated via CHANGELOG |

## Domain vocabulary

| Term | Definition | Source |
|------|-----------|--------|
| `HarnessStreamPart` (stream.ts) | Authoritative runtime stream union; contains `text-delta`, flow, tool, interactive events | `types/stream.ts:7-25` |
| `HarnessStreamPart` (voice.ts) | Voice/realtime stream union; superset with pipeline, safety, step events | `types/voice.ts:265` |
| `AgentStreamPart` | Legacy hook callback shape; shares old `text-delta` with `.text` field | `types/processors.ts:92-102` |
| `text-start`/`text-delta`/`text-end`/`text-cancel` | New four-variant assistant-text lifecycle, replacing single-shot `text-delta` | RFC §4.1 |
| `TurnHandle` | Promise + `AsyncIterable<HarnessStreamPart>` + SSE serializer; external API surface | `types/stream.ts:27-31` |
| `EventBus` | In-process event emitter backed by a push-array + async-iterator waiters | `events/TurnHandle.ts:4-6` |
| `ctx.emit()` | The single emit surface; accepts `HarnessStreamPart` from stream.ts | `run-context.ts:56` |
| `RunContext` | Per-turn context holding session, model, policies, emit; lives for one `runtime.run()` | `types/run-context.ts` |

## Tribal knowledge

### Gotchas from code

1. **Voice union re-declares HarnessStreamPart** (`voice.ts:265`) — this is intentional, not a name collision. The voice union is a superset with pipeline/safety/step events. `RunContext.emit()` uses the stream.ts union; hooks use the voice union. During S1-01, both unions get the same four lifecycle variants but the voice union retains its extra members.

2. **`extractionTurn.ts` skips text-delta** (`:46`) — the comment "Intentionally NOT handling 'text-delta' — extraction never speaks" confirms REQ-12. This code iterates `result.fullStream` (AI SDK's stream, not Kuralle's) and ignores the AI SDK's `text-delta` parts. The extraction path does NOT emit any Kuralle `text-delta` events. No change needed. Confidence: **high**.

3. **`StreamAdapter.ts:78-83` already outputs new SSE shape** — the comment at `:11` shows `data: {"type":"text-delta","delta":"Hello"}`, and the code at `:83` outputs `delta: part.text`. The **output** SSE format is already forward-looking; only the **input** read (`part.text`) needs to change. This means the CF adapter was partially pre-migrated.

4. **`postcall-audit/02-runtime-stream-on-session-end.ts:18` already uses new shape** — `{ type: 'text-delta' as const, id, delta: text }` — this test was written with the new protocol in mind.

5. **`KuralleRuntimeLLMAdapter.ts:208-219` has a `part.type !== 'text-delta'` early-continue** — the adapter filters out all non-text-delta events. After S1-01, this filter must also pass `text-start`/`text-end`/`text-cancel` (for lifecycle handling) OR continue to ignore them (RFC says ignore start/end, stop on cancel). In S1-01 compile-only mode, change `!== 'text-delta'` to `!== 'text-delta' && !== 'text-start' && !== 'text-end' && !== 'text-cancel'` is NOT needed if the adapter only pushes to TTS on `text-delta` — but the filter must NOT throw on unrecognized types. The simpler fix: change the filter condition and map `.text` → `.delta`.

6. **`tool-interim-timeout.test.ts:32` constructs `parts.push({ type: 'text-delta', text: message })`** — this is a test-side array construction, NOT a `ctx.emit()`. It tests the `onInterim` callback which in the real path creates `text-delta` events. After S1-01, `onInterim` should emit the lifecycle trio, and the test should construct the new shape.

## Open questions

| ID | Question | Would resolve if | Suggested command |
|----|----------|------------------|-------------------|
| O1 | Should `AgentStreamPart` (`processors.ts:92-102`) be updated in S1-01? | Manager decides based on this analysis | Read `types/runtime.ts:25-31`, `types/processors.ts:92-102` |
| O2 | Does `streamFilter.ts` `SAFE_EVENT_TYPES` need `text-start`/`text-end`/`text-cancel`? If a client (`'safe'` mode) receives only `text-delta` but not `text-start`/`text-end`, is that correct? | Manager/reviewer decides the safe-mode contract for the new lifecycle | Read `streamFilter.ts:2-4`, RFC §5.3 |
| O3 | Should the `KuralleRuntimeLLMAdapter` filter condition be changed in S1-01 (compile-only) or deferred to Sprint 3? | Manager decides: minimal compile fix (just `.text` → `.delta`) or full lifecycle handling now | Read `KuralleRuntimeLLMAdapter.ts:206-219` |
| O4 | In `TextDriver`, should `onInterim` (`Runtime.ts:131`) emit a full text-start/text-delta/text-end or just a text-delta without lifecycle framing (for a transient "still working" message)? | Manager + RFC author decide whether interim messages are part of the main turn or separate mini-turns | Read `Runtime.ts:128-132`, RFC §4.1 |

## Confidence summary

| Section | Confidence | Gap |
|---------|------------|-----|
| Union definitions | **high** | All three unions (2 in scope, 1 under decision) identified with exact lines |
| Producer sites (emit) | **high** | All 12 `ctx.emit()` + 2 JSON-construct sites traced |
| Consumer sites (read) | **high** | All 13 `.text` read sites + 1 filter-set mapped |
| Generic serializers | **high** | SSE/ndjson confirmed generic; hooks confirmed passthrough |
| AgentStreamPart status | **high** | Not in live emit path; separate hook contract; decision needed |
| Test/example count | **high** | 40+ test files, 20+ example files, all identified |
| S1-01 compile-gating | **high** | All files in `packages/*/test/` gate `typecheck:all`; examples are not compile-gated but referenced by docs |
| Cascaded adapter deferred | **high** | Sprint 3 deferred confirmed by WBS §Sprint 3 |

## Recommended S1-01 change ordering

1. **Types first** (mechanical, no behavior change):
   - Remove old `text-delta` from `types/stream.ts:11`, add four lifecycle variants
   - Remove old `text-delta` from `types/voice.ts:266`, add four lifecycle variants
   - (If decided) Same for `types/processors.ts:92`

2. **Producers next** (mechanical emit-site updates):
   - `degrade.ts:22` — simplest (single emit site, no dependencies)
   - `collectUntilComplete.ts:149` — single emit + turn-end after
   - `collectDigression.ts:125` — single emit + turn-end after
   - `Runtime.ts:131` — onInterim (lifecycle trio or just text-delta — per O4 decision)
   - `Runtime.ts:246` — degraded message (lifecycle trio)
   - `TextDriver.ts:58,136` — blocked + normal paths (lifecycle trio per S1-01 mechanical, true streaming lands in S1-03)
   - `VoiceDriver.ts:52,90,105` — blocked + interrupt + normal (lifecycle trio; true streaming in Sprint 2)

3. **Core internal consumers:**
   - `DefaultConversationEventLog.ts:45-48` — `part.text` → `part.delta`
   - `EvalRunner.ts:33-34` — `part.text` → `part.delta`

4. **Transport adapters:**
   - `streamFilter.ts:4` — update `SAFE_EVENT_TYPES`
   - `hono-server/src/index.ts` — 6 consumer + 2 producer sites
   - `hono-server/src/openaiCompat.ts` — 2 consumer sites
   - `kuralle-cf-agent/src/StreamAdapter.ts:83` — `part.text` → `part.delta`

5. **Client libraries:**
   - `kuralle-widget/src/client/WidgetClient.ts` — `data.text` → `data.delta`
   - `kuralle-messaging/src/adapter/stream-mapper.ts` — `part.text` → `part.delta`
   - `kuralle-messaging/src/stream-filter.ts` — type guard update

6. **Cascaded adapter (compile-only S1-01):**
   - `KuralleRuntimeLLMAdapter.ts:208-219` — `part.text` → `part.delta`, filter update

7. **Tests** (batch-update all compile-critical):
   - All test files in `packages/*/test/` that construct or consume the old shape
   - Use mechanical find-replace: `{ type: 'text-delta', text: X }` → `{ type: 'text-delta', id: 't0', delta: X }` for simple test fixtures
   - For tests that read `part.text`, change to `part.delta`

8. **Examples** (batch-update):
   - All example files in `packages/*/examples/`
   - `standalone-agent.ts` is the most heavily referenced — prioritize it

9. **Verify:**
   - `bun run typecheck:all` — must pass
   - `bun run test` — must pass
   - Manual check: `grep -rn "\.text\b" packages --include="*.ts" | grep -v "\.text\b" | grep "HarnessStreamPart\|text-delta"` — zero hits for old `.text` field on text-delta types

## Sentinel

This artifact maps all 86 `text-delta`-referencing files across 8 packages into the classification buckets above. Every producer and consumer is identified with file:line and a one-line migration instruction. The `AgentStreamPart` question is answered with evidence and flagged for manager decision.
