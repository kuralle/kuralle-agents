# ADR 0004 — Streaming-by-default (incremental commit at the smallest guardrail boundary)

**Status:** Accepted (2026-06-05)
**Context:** `docs/rfc-streaming-by-default.md`, ADR 0002/0003 (post-turn gate introduced global buffering), `docs/kuralle-hardening-plan.md` (H6 whole-answer grounding gate).
**Related:** REQ-9 native-realtime advisory; unified `0.4.0` breaking release (S4-03).

## Context

Before this change, `TextDriver` and `VoiceDriver` streamed the model internally but **accumulated** tokens into `draftText`, ran `applyPostTurnPolicies` on the complete text, then emitted the entire turn as a single `{ type: 'text-delta'; text: string }`. Every reply node paid full-completion latency even when no blocking gate was attached.

The post-turn gate exists because a whole-answer validator can veto or rewrite the entire message — but that requirement was applied **globally**, not only on nodes that actually need whole-answer buffering.

## Decision

**Stream up to the smallest commit boundary each attached guardrail permits; never emit past a boundary an unsatisfied blocking gate has not cleared.**

### 1. Shared emission path (`speakGated`)

Text and native-voice speaking turns share one gated emitter fed by a `TokenSource`. The two drivers differ only in how they produce tokens (model stream vs. provider transcript), not in how they gate or emit.

### 2. Three stream modes (auto-selected per node)

| Mode | When selected | Emission behavior | Gate runs |
|------|---------------|-------------------|-----------|
| `token` | No blocking gate attached | Each model token emitted immediately as `text-delta{id, delta}` | None |
| `sentence` | Any attached gate declares `streamGranularity: 'sentence'` (and none declare `turn`) | Tokens aggregated to sentence boundaries; each cleared sentence emitted; block ⇒ `text-cancel` + safe message | Per completed sentence, before emit |
| `turn` | Any attached gate declares `streamGranularity: 'turn'`, or a whole-answer grounding gate is active | Full turn buffered; gate runs once; then emitted (today's behavior, scoped to these nodes only) | Once on complete text |

Effective mode is the **coarsest** granularity among all attached output processors, validation policies, and the node's active grounding gate. Gates that omit `streamGranularity` default to `turn` (safe-by-default).

### 3. Breaking assistant-text lifecycle (REQ-6, REQ-7)

The single-shot `{ type: 'text-delta'; text: string }` is **removed**. No alias, no dual-emit, no compatibility shim.

New lifecycle (one `text-start` / `text-end` pair per speaking turn; all deltas share the same `id`):

```ts
| { type: 'text-start'; id: string }
| { type: 'text-delta'; id: string; delta: string }
| { type: 'text-end'; id: string }
| { type: 'text-cancel'; id: string; reason: string }
```

Applied to all three public unions:

- `HarnessStreamPart` (`types/stream.ts`) — authoritative runtime/SSE stream
- Voice union (`types/voice.ts`) — native realtime events
- `AgentStreamPart` (`types/processors.ts`) — `Hook.onStreamPart` callback contract

**Consumer migration:** `part.text` → `part.delta`; handle `text-start` / `text-end` for message boundaries; on `text-cancel`, stop accumulating for that `id` and expect a fresh lifecycle for any safe replacement message.

`HarnessStreamPart` also gained `safety-blocked` and `pipeline-validation-block` variants (post-turn gate outcomes surfaced on the stream).

### 4. REQ-9 — native realtime honesty

Two voice substrates behave differently:

| Substrate | Kuralle controls emission? | Gate effect |
|-----------|------------------------------|-------------|
| **Cascaded** (LiveKit STT → Kuralle text runtime → TTS) | Yes — preventive | Blocked content never reaches TTS |
| **Native realtime** (Gemini/OpenAI/xAI speech-to-speech) | No — provider speaks audio as it generates | Whole-answer gate is **advisory**: emits `safety-blocked` / `pipeline-validation-block`, triggers provider interrupt + correction utterance post-hoc; cannot un-speak audio already played |

Documentation and the `@kuralle-agents/realtime-audio` README state this explicitly. Reliable controls on native realtime are **input-side gating** (pre-turn policies) and **tool authority** (tools return data, not conversational text).

### 5. Versioning

Shipped as **`0.4.0`**, unified across all packages in one `pnpm publish -r` release. Breaking-change note: `part.text` → `part.delta` + lifecycle. No runtime flag to toggle — rollback is at the release boundary.

## Consequences

- **Pro:** Ungated reply nodes emit multiple `text-delta` events with first-token latency; cascaded LiveKit TTS begins on the first delta (`aria_runtime_ttft` = first-token, not turn-end). Grounded nodes retain buffered behavior only where the gate requires it.
- **Pro:** Text and voice share one gating implementation; sentence-mode gates never emit a blocked sentence's text on Kuralle-controlled paths.
- **Con:** Breaking protocol change — every consumer of `HarnessStreamPart` / voice / `AgentStreamPart` must migrate `part.text` → `part.delta` and handle the lifecycle framing.
- **Con:** Native realtime whole-answer gates cannot claim preventive blocking; authors must not rely on them as the sole safety control for spoken audio.

## Acceptance

- Ungated multi-token reply emits >1 `text-delta` before `turn-end`; first delta precedes completion.
- Turn-mode (grounding) node buffers; blocked content never appears in the stream.
- Sentence-mode block: cleared sentences emitted; blocked sentence absent; `text-cancel` + safe message on late block.
- Cascaded adapter maps `text-delta.delta` into TTS; `text-cancel` halts forwarding; TTFT fires on first delta.
- Docs and ADR state REQ-9 advisory constraint; no public doc references removed `text-delta.text` shape.
