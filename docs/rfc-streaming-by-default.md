# RFC: Streaming-by-default — incremental commit at the smallest guardrail boundary

**Category:** Architectural Change
**Author:** octalpixel
**Date:** 2026-06-05
**Status:** Draft
**Reviewers:** TBD
**Related:**
- `docs/adr/0002-conversational-stability-hardening.md`, `docs/adr/0003-out-of-band-control-evaluator.md` (the hardening backlog that introduced the post-turn gate)
- `docs/kuralle-hardening-plan.md` (H6 author-reachable confidence/grounding gate — the whole-answer gate this RFC scopes)
- Reference frameworks studied for this RFC (cloned `2026-06-05`): Pipecat (`services/openai/base_llm.py:499`, `services/tts_service.py:946`, `processors/frame_processor.py:854,1013`), LiveKit Agents (`voice/agent.py:316-526`, `voice/generation.py:143-184`, `voice/agent_activity.py:2676-2684`), LangGraph (`pregel/_messages.py:151`, `pregel/_loop.py:676`).
- This RFC ships with **ADR 0004** (`docs/adr/0004-streaming-by-default.md`) recording the decision.

---

## 1. Problem Statement

Kuralle buffers every speaking turn before emitting a single token. `TextDriver.runAgentTurn` streams the model internally via `streamText` but only **accumulates** tokens into `draftText` (`packages/kuralle-core/src/runtime/channels/TextDriver.ts:69-79`), runs `applyPostTurnPolicies` on the complete text, then emits the **entire turn as one `text-delta`** (`TextDriver.ts:135-144`). `VoiceDriver` does the same (`VoiceDriver.ts:78-103`).

This has three measurable costs:

1. **Latency.** Time-to-first-output equals the full LLM completion plus the gate, not the first token. For a 300-token answer this is the difference between ~200ms and ~3s of perceived silence.
2. **Cascaded voice is the worst case.** `KuralleRuntimeLLMStream.run` maps each `text-delta` into a LiveKit TTS chunk (`packages/kuralle-livekit-plugin/src/llm/KuralleRuntimeLLMAdapter.ts:208-219`). Because the runtime emits one `text-delta` at turn-end, TTS receives the **whole turn at once** — first-audio latency is gated on the entire completion. The adapter's own `aria_runtime_ttft` metric (`KuralleRuntimeLLMAdapter.ts:176-184`) measures exactly this penalty and today fires only at turn-end.
3. **The buffer is unconditional even when nothing needs it.** With no validation/output policies configured, `runValidationPolicies` returns the text untouched (`packages/kuralle-core/src/runtime/policies/agentTurn.ts:144-146`) and output processors are skipped (`agentTurn.ts:243`). The common case pays full buffering latency to run a gate that does nothing.

**Success criteria (post-implementation):**

- A multi-token reply on a node with no blocking gate emits **more than one** `text-delta` event, with the first arriving before the completion finishes (observable; asserted by test).
- Cascaded LiveKit TTS receives its first text chunk before the runtime turn completes (`aria_runtime_ttft` drops to first-token latency).
- A node with a **whole-answer** gate (H6 grounding/confidence) still never emits content the gate would block — the buffered behavior is preserved **only on those nodes**.
- A node with a **per-utterance** blocking gate streams cleared sentences and never emits a sentence the gate rejected.
- Text and voice traverse **one** gating-and-emission path (the codebase's stated goal — `VoiceDriver.ts:121`).

## 2. Background

### 2.1 Why the buffer exists

The post-turn gate can **replace** the whole turn. `applyPostTurnPolicies` (`agentTurn.ts:233-270`) runs two stages on the complete assistant text:

- **Output processors** (`agentTurn.ts:243-264`) — may `block` (replace with a safe message) or rewrite the text.
- **Validation policies** (`runValidationPolicies`, `agentTurn.ts:138-203`) — may `block`/`escalate` (replace with `safeBlockedText`, `agentTurn.ts:165-189`) or `rewrite` the whole output (`agentTurn.ts:191`).

Because a gate can veto or rewrite the entire message, the driver cannot stream tokens it might have to retract. So it buffers. This was the correct, safe choice when the gate was introduced (the hardening backlog, ADR 0002/0003) — but it was applied **globally**, to every reply node, regardless of whether any gate is attached or whether the attached gate actually needs the whole answer.

### 2.2 What the reference frameworks do

All three open-source orchestration frameworks studied stream by default; buffering is the opt-in exception:

- **Pipecat** pushes one `LLMTextFrame` per provider delta (`services/openai/base_llm.py:499`), aggregates to sentences only at the TTS boundary (`services/tts_service.py:946`), and has **no post-LLM content gate** — its only corrective primitive is `InterruptionFrame`, a system frame that bypasses all queues and cancels in-flight LLM+TTS (`processors/frame_processor.py:854,1013`).
- **LiveKit** models every stage as `AsyncIterable[in] -> AsyncIterable[out]` (`voice/agent.py:316-400`); you gate by wrapping the generator and filtering per chunk; whole-answer buffering is an explicit `LLMStream.collect()` opt-in. LLM deltas feed TTS via `push_text` the instant they arrive (`voice/generation.py:143-184` → `voice/agent_activity.py:2676-2684`).
- **LangGraph** runs a **dual channel**: committed state at node boundaries (`pregel/_loop.py:676`) is orthogonal to a continuous token side-channel (`on_llm_new_token` → shared queue, `pregel/_messages.py:151`).

The convergent lesson: **buffer-then-emit is nobody's default**. Output is a transformable stream; whole-answer validation is the exception, handled by per-chunk transform, per-sentence gate, or opt-in whole-turn buffering.

### 2.3 The reconciling principle

A blocking guardrail that streams-then-retracts is not a guardrail — for a text consumer the bytes already left the process and are in the client, the logs, the scrollback. Therefore retraction is **rejected** as a default for Kuralle-controlled emission. The principle this RFC adopts:

> Stream up to the smallest commit boundary each attached guardrail's semantics permit; never emit past a boundary an unsatisfied blocking gate has not cleared.

Three boundaries, auto-selected per node by the coarsest attached gate: **token** (no gate), **sentence** (per-utterance gate), **turn** (whole-answer gate).

### 2.4 Two voice substrates (a hard constraint, stated honestly)

- **Cascaded** (`KuralleRuntimeLLMAdapter`): Kuralle's runtime *is* the LLM; LiveKit TTS is downstream and consumes `text-delta` chunks. Kuralle **controls the emission boundary** — a sentence gated before emission is never synthesized. The invariant holds fully.
- **Native realtime** (`VoiceDriver` + `RealtimeAudioClient`, Gemini/OpenAI realtime): the provider **speaks audio as it generates**; `onTranscript` delivers the assistant transcript incrementally and `heardCharCount` tracks what was already spoken (`VoiceDriver.ts:172-180`). Kuralle does **not** control the audio emission boundary — audio reaches the user via the provider before any Kuralle gate runs. Here a blocking gate is necessarily **post-hoc**: it can truncate and speak a correction (the existing barge-in/`truncateAt` mechanics, `VoiceDriver.ts:80-87,213-227`) but cannot un-speak audio. **The "never emit blocked content" invariant cannot hold for native realtime audio**, and this RFC does not pretend otherwise (see REQ-9 and Section 10).

> Footnote — alternatives considered and rejected for the default: (a) *optimistic stream + retract everywhere* — rejected because retract is a safety fiction for text/cascaded TTS; (b) *keep global buffering, add an opt-in streaming flag* — rejected because it makes the worse behavior the default and the better behavior the exception, the opposite of "best industry defaults"; (c) *token-stream everything, drop the whole-answer gate* — rejected because the built-in grounding/confidence gate is Kuralle's differentiator over Pipecat/LiveKit.

## 3. Strict Requirements

- **REQ-1:** A reply node with **no** attached blocking gate (no output processors, no validation policies, no whole-answer grounding gate active) MUST stream raw token deltas as `streamText().fullStream` yields them. No accumulation-before-emit.
- **REQ-2:** A reply node with a gate whose declared granularity is `sentence` MUST aggregate tokens to sentence boundaries, run the gate per completed sentence, emit cleared sentences immediately, and on a block emit no further content from that turn except the safe message.
- **REQ-3:** A reply node with a gate whose declared granularity is `turn` (the H6 grounding/confidence gate) MUST buffer the full turn, run the gate once on the complete text, then emit — preserving today's behavior, but only on such nodes.
- **REQ-4:** The effective mode for a node is the **coarsest** granularity among all attached gates: `turn` if any gate is `turn`; else `sentence` if any gate is `sentence`; else `token`. Mode selection is pure and unit-testable.
- **REQ-5:** Gate authors declare granularity via a `streamGranularity: 'sentence' | 'turn'` field on the policy/processor interface. **A gate that does not declare one defaults to `turn`** (conservative — unknown gates buffer). Streaming is an explicit opt-in by the gate author.
- **REQ-6 (event protocol, breaking):** The single-shot `{ type: 'text-delta'; text: string }` is **removed**. The new assistant-text lifecycle is `text-start{id}` / `text-delta{id, delta}` / `text-end{id}` / `text-cancel{id, reason}`, applied to **all three** in-scope unions: `HarnessStreamPart` (`types/stream.ts`), the voice union (`types/voice.ts`), and `AgentStreamPart` (`types/processors.ts`). No alias, no dual-emit, no compatibility shim.
- **REQ-7:** One speaking turn emits exactly one `text-start`/`text-end` pair; all deltas for that turn carry the same `id`. A turn blocked **before** any delta emits a fresh `text-start`/`text-delta`/`text-end` carrying only the safe message (no `text-cancel`). A turn blocked **after** partial emit (sentence mode) emits `text-cancel{id}` followed by a fresh lifecycle for the safe message.
- **REQ-8:** Text and native-voice speaking turns MUST share a single emission-and-gating implementation fed by a `TokenSource` abstraction. The two drivers differ only in how they produce tokens (model stream vs. provider transcript), not in how they gate or emit.
- **REQ-9 (native realtime honesty):** On the native realtime path a `turn`-granularity gate runs **post-hoc**: it emits the relevant `safety-*`/`pipeline-validation-*` events and, on block, triggers the provider interrupt + correction utterance, but it MUST NOT claim to have prevented emission. Documentation MUST state that whole-answer content gates are advisory on native realtime audio and that input-side gating + tool authority are the reliable controls there.
- **REQ-10:** The cascaded adapter (`KuralleRuntimeLLMStream.run`) MUST map `text-delta.delta` (not `.text`) into TTS chunks, ignore `text-start`/`text-end`, and on `text-cancel` stop forwarding for the current turn.
- **REQ-11:** No backward-compatibility layer anywhere. This is a breaking release; all in-repo consumers (drivers, adapter, SSE serializer consumers, tests, examples, docs) are updated in the same change. Version bumps to `0.4.0` unified across all packages.
- **REQ-12:** `runExtraction` (silent field extraction) MUST remain non-speaking and emit **no** text lifecycle events (`extractionTurn.ts` — "extraction never speaks"). Streaming changes do not touch it.

## 4. Interface Specification

### 4.1 `HarnessStreamPart` — text lifecycle (breaking)

- **Location:** `packages/kuralle-core/src/types/stream.ts`
- **Change:** remove `| { type: 'text-delta'; text: string }`; add:
  ```ts
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'text-cancel'; id: string; reason: string }
  ```
- **Behavior:** `id` is the per-turn assistant message id (`crypto.randomUUID()` at turn start). Mirrors AI SDK v6 `UIMessageChunk` so any v6 consumer maps 1:1.
- **Error cases:** consumers that pattern-matched the removed `.text` field on `text-delta` no longer typecheck — intentional; they are updated in this change (in-repo) or by downstream consumers (breaking-release note).

### 4.2 Voice union — same lifecycle

- **Location:** `packages/kuralle-core/src/types/voice.ts:266`
- **Change:** replace `{ type: 'text-delta'; text: string }` with the same four-variant lifecycle. The existing `pipeline-validation-*` / `safety-*` events (`voice.ts:285-303`) are unchanged and now interleave with sentence-level deltas.

### 4.2.1 `AgentStreamPart` — same lifecycle (hook callback contract)

- **Location:** `packages/kuralle-core/src/types/processors.ts` (`AgentStreamPart`)
- **Change:** same four-variant lifecycle as §4.1–4.2.
- **Rationale:** `AgentStreamPart` (`types/processors.ts`) — the `Hook.onStreamPart` callback contract — carries the same `text-delta` member and is flipped to the same lifecycle in the same change (REQ-11: no dual-shape). (Amended during S1-01; the original RFC named only `stream.ts`/`voice.ts`.)

### 4.3 `StreamMode` + `resolveStreamMode`

- **Location:** `packages/kuralle-core/src/runtime/channels/streaming/mode.ts` (new)
- **Signature:**
  ```ts
  export type StreamMode = 'token' | 'sentence' | 'turn';
  export function resolveStreamMode(ctx: RunContext, node: ResolvedNode): StreamMode;
  ```
- **Behavior:** returns the coarsest granularity among `ctx.outputProcessors`, `ctx.validationPolicies`, and the node's active grounding gate; `token` when none are attached. Pure function of the attached gates' declared `streamGranularity`.
- **Error cases:** a gate with no declared granularity is treated as `turn` (REQ-5).

### 4.4 `SentenceAggregator`

- **Location:** `packages/kuralle-core/src/runtime/channels/streaming/SentenceAggregator.ts` (new)
- **Signature:**
  ```ts
  export class SentenceAggregator {
    push(tokenText: string): string[];   // returns zero or more completed sentences
    flush(): string | null;              // returns the trailing partial sentence, if any
  }
  ```
- **Behavior:** accumulates token text; emits a sentence when `matchEndOfSentence` confirms a boundary (terminal punctuation + lookahead guard for decimals/abbreviations, e.g. `"$29."` vs `"$29. Next"`). Mirrors Pipecat's `SimpleTextAggregator` lookahead (`utils/text/simple_text_aggregator.py:104-110`) without an NLP dependency.
- **Error cases:** `flush()` on empty buffer returns `null`.

### 4.5 `TokenSource` + `speakGated`

- **Location:** `packages/kuralle-core/src/runtime/channels/streaming/speakGated.ts` (new)
- **Signature:**
  ```ts
  export interface TokenSource {
    [Symbol.asyncIterator](): AsyncIterator<{ delta: string }>;
  }
  export async function speakGated(args: {
    ctx: RunContext;
    mode: StreamMode;
    turnId: string;
    source: TokenSource;
    runGate: (fullOrSentence: string, final: boolean) => Promise<GateOutcome>;
  }): Promise<{ text: string; control?: TurnControl; confidence?: number }>;
  ```
- **Behavior:** the single shared emission path (REQ-8). Drives the `TokenSource`; in `token` mode emits each delta immediately; in `sentence` mode emits per cleared sentence; in `turn` mode accumulates, gates once at end, emits. Emits the `text-start`/`text-delta`/`text-end`/`text-cancel` lifecycle. Returns the final emitted text plus any control signal from the gate.
- **Error cases:** a thrown error from `source` propagates after emitting `{ type: 'error' }` (preserving `TextDriver.ts:73-78` semantics); the lifecycle is closed with `text-cancel` if a `text-start` was already emitted.

### 4.6 Gate interface additions

- **Location:** `packages/kuralle-core/src/types/processors.ts` (output `Processor`) and the `ValidationPolicy` type (`packages/kuralle-core/src/capabilities/ValidationCapability.ts`)
- **Change:** add `readonly streamGranularity?: 'sentence' | 'turn'` (default `turn`). No behavioral change to existing `validate`/`process` contracts.

## 5. Architecture and System Dependencies

### 5.1 Structural Changes

**Created:**
- `packages/kuralle-core/src/runtime/channels/streaming/mode.ts` — `resolveStreamMode`.
- `packages/kuralle-core/src/runtime/channels/streaming/SentenceAggregator.ts` — token→sentence + `matchEndOfSentence`.
- `packages/kuralle-core/src/runtime/channels/streaming/speakGated.ts` — shared gated emitter + `TokenSource`.

**Modified:**
- `TextDriver.runAgentTurn` — replace the accumulate-then-emit block (`TextDriver.ts:58-147`) with: build a `TokenSource` from `streamText().fullStream`, call `speakGated`. The tool-call step loop (`TextDriver.ts:60-133`) is preserved; only text emission moves into `speakGated`. In `turn` mode the gate runs once after the loop (today's call site); in `token`/`sentence` mode deltas stream within each step.
- `VoiceDriver.runAgentTurn` — replace the accumulate-then-emit block (`VoiceDriver.ts:65-106`) with a `TokenSource` adapter over `onTranscript` assistant events feeding `speakGated`. Native-realtime caveat per REQ-9.
- `types/stream.ts`, `types/voice.ts` — event lifecycle (REQ-6).
- `KuralleRuntimeLLMAdapter.ts:208-219` — consume `text-delta.delta`, handle lifecycle (REQ-10).
- `types/processors.ts`, `ValidationCapability.ts` — `streamGranularity` field (REQ-5).

**Deleted:** the unconditional `draftText` accumulation + single trailing `text-delta` emit in both drivers.

### 5.2 Service and Library Dependencies

No new runtime dependencies. `SentenceAggregator` uses a hand-rolled `matchEndOfSentence` (regex + abbreviation list) rather than an NLP package, consistent with the framework's lean-dependency posture. The Vercel AI SDK `streamText` / `fullStream` contract is unchanged (already used at `TextDriver.ts:61`).

### 5.3 Data and Schema Changes

None persisted. The SSE/ndjson serializer is generic `JSON.stringify(part)` (`packages/kuralle-core/src/events/TurnHandle.ts:90-92`) and needs no change — the new event shapes serialize transparently. Conversation audit records (`appendConversationAudit`) are unchanged.

### 5.4 Network and Performance Considerations

- **Latency win (REQ-1/REQ-2 nodes):** TTFT drops from full-completion to first-token (token mode) or first-sentence (sentence mode).
- **Cascaded TTS:** first audio now begins after the first sentence instead of the full turn; `aria_runtime_ttft` (`KuralleRuntimeLLMAdapter.ts:176`) reflects the improvement.
- **Cost of sentence mode:** ~one sentence of buffering on gated nodes (the same unit voice TTS already uses). Token-mode nodes pay nothing.
- **Event volume:** more `text-delta` events per turn. SSE framing is unchanged; payload count rises proportionally to token/sentence count. Acceptable — this is the standard streaming profile.

## 6. Pseudocode

```
FUNCTION runAgentTurn(node, ctx):
    IF NOT preTurn.proceed:
        emitFullMessage(turnId, preTurn.blockedMessage)   # start/delta/end
        RETURN

    mode = resolveStreamMode(ctx, node)        # token | sentence | turn
    turnId = uuid()
    source = tokenSourceFor(node, ctx)         # model stream OR provider transcript
    RETURN speakGated(ctx, mode, turnId, source, runGate=postTurnGate)

FUNCTION speakGated(ctx, mode, turnId, source, runGate):
    IF mode == 'turn':
        full = ""
        FOR delta IN source: full += delta     # accumulate, emit nothing
        decision = runGate(full, final=true)
        emitFullMessage(turnId, decision.text) # buffered emit (today's behavior)
        RETURN decision

    started = false
    agg = SentenceAggregator()
    FOR delta IN source:
        IF mode == 'token':
            IF NOT started: emit text-start{turnId}; started = true
            emit text-delta{turnId, delta}
        ELSE IF mode == 'sentence':
            FOR sentence IN agg.push(delta):
                decision = runGate(sentence, final=false)
                IF decision.blocked:
                    IF started: emit text-cancel{turnId, reason}
                    emitFullMessage(uuid(), decision.safeMessage)
                    RETURN decision
                IF NOT started: emit text-start{turnId}; started = true
                emit text-delta{turnId, delta=sentence}

    IF mode == 'sentence':
        tail = agg.flush()
        IF tail: decision = runGate(tail, final=true); ... emit or cancel
    IF started: emit text-end{turnId}
    RETURN { text: emittedSoFar }
```

## 7. Code Blueprint

```ts
// packages/kuralle-core/src/runtime/channels/streaming/mode.ts
import type { RunContext } from '../../../types/run-context.js';
import type { ResolvedNode } from '../../../types/channel.js';

export type StreamMode = 'token' | 'sentence' | 'turn';

export function resolveStreamMode(ctx: RunContext, node: ResolvedNode): StreamMode {
  const grans = [
    ...(ctx.outputProcessors ?? []).map(p => p.streamGranularity ?? 'turn'),
    ...(ctx.validationPolicies ?? []).map(p => p.streamGranularity ?? 'turn'),
  ];
  // A whole-answer grounding gate active on this node contributes 'turn'.
  if (nodeHasWholeAnswerGroundingGate(ctx, node)) grans.push('turn');
  if (grans.includes('turn')) return 'turn';
  if (grans.includes('sentence')) return 'sentence';
  return 'token';
}
```

```ts
// packages/kuralle-core/src/runtime/channels/streaming/speakGated.ts
export async function speakGated(args: SpeakGatedArgs): Promise<SpeakGatedResult> {
  const { ctx, mode, turnId, source, runGate } = args;

  if (mode === 'turn') {
    let full = '';
    for await (const { delta } of source) full += delta;
    const decision = await runGate(full, true);            // applyPostTurnPolicies(full)
    emitMessage(ctx, turnId, decision.text);               // start + delta + end
    return { text: decision.text, control: decision.control, confidence: decision.confidence };
  }

  const agg = new SentenceAggregator();
  let started = false;
  let emitted = '';
  const openOnce = () => { if (!started) { ctx.emit({ type: 'text-start', id: turnId }); started = true; } };

  for await (const { delta } of source) {
    if (mode === 'token') {
      openOnce();
      ctx.emit({ type: 'text-delta', id: turnId, delta });
      emitted += delta;
      continue;
    }
    for (const sentence of agg.push(delta)) {               // mode === 'sentence'
      const d = await runGate(sentence, false);
      if (d.blocked) {
        if (started) ctx.emit({ type: 'text-cancel', id: turnId, reason: d.reason });
        emitMessage(ctx, crypto.randomUUID(), d.safeMessage);
        return { text: d.safeMessage, control: d.control };
      }
      openOnce();
      ctx.emit({ type: 'text-delta', id: turnId, delta: sentence });
      emitted += sentence;
    }
  }
  const tail = agg.flush();
  if (tail) { /* gate tail (final=true), emit or cancel as above */ }
  if (started) ctx.emit({ type: 'text-end', id: turnId });
  return { text: emitted };
}
```

```ts
// packages/kuralle-core/src/runtime/channels/TextDriver.ts  (runAgentTurn, abridged)
const mode = resolveStreamMode(ctx, node);
const turnId = crypto.randomUUID();
const source: TokenSource = streamTextTokenSource(() => streamText({
  model, system, messages, tools: aiTools, abortSignal: ctx.abortSignal,
}), { onStep: handleToolCalls });           // tool-call loop stays here; text flows to speakGated
const spoken = await speakGated({
  ctx, mode, turnId, source,
  runGate: (text, final) => applyPostTurnPolicies(ctx, text, toolCallsMade, gather.citations ?? [])
    .then(toGateOutcome),
});
out.text = spoken.text; out.control = spoken.control; out.confidence = spoken.confidence;
ctx.emit({ type: 'turn-end' });
```

```ts
// packages/kuralle-livekit-plugin/src/llm/KuralleRuntimeLLMAdapter.ts  (run loop, REQ-10)
for await (const part of handle.events) {
  if (part.type === 'error') throw new Error(part.error);
  if (part.type === 'text-cancel') { /* stop forwarding this turn */ continue; }
  if (part.type !== 'text-delta') continue;          // ignore text-start / text-end
  recordTtftOnce();
  this.queue.put({ id: `kuralle-${chunkIndex++}`, delta: { role: 'assistant', content: part.delta } });
}
```

Attribution: the sentence boundary lookahead follows Pipecat's `SimpleTextAggregator` (`utils/text/simple_text_aggregator.py:104-110`); the `TokenSource`-as-transformable-stream shape follows LiveKit's node contract (`voice/agent.py:316-400`); the dual-channel framing (committed turn vs. continuous deltas) follows LangGraph (`pregel/_loop.py:676`, `pregel/_messages.py:151`).

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding (REQ/test) | Acceptance criteria |
|----|-------|-------|----------------------|---------------------|
| C1 | Event lifecycle types (breaking) | `types/stream.ts`, `types/voice.ts` | REQ-6, REQ-7 | Both unions expose `text-start/delta{id,delta}/end/cancel`; `text` field removed; `bun run typecheck` flags all in-repo consumers |
| C2 | `streamGranularity` field on gate interfaces | `types/processors.ts`, `capabilities/ValidationCapability.ts` | REQ-5 | Field present, defaults documented; existing policies compile |
| C3 | `resolveStreamMode` | `runtime/channels/streaming/mode.ts` | REQ-4, `mode.test` | Returns coarsest granularity; `token` when no gates; unit tests green |
| C4 | `SentenceAggregator` + `matchEndOfSentence` | `runtime/channels/streaming/SentenceAggregator.ts` | REQ-2, `aggregator.test` | Splits multi-sentence; guards decimals/abbreviations; flush returns tail |
| C5 | `speakGated` + `TokenSource` | `runtime/channels/streaming/speakGated.ts` | REQ-1,2,3,7,8, `speakGated.test` | All three modes emit correct lifecycle; block paths covered |
| C6 | TextDriver on shared path | `runtime/channels/TextDriver.ts` | REQ-1,3,8,12 | Tool loop preserved; emits via `speakGated`; extraction untouched |
| C7 | VoiceDriver on shared path + native-realtime caveat | `runtime/channels/VoiceDriver.ts` | REQ-8, REQ-9 | Transcript `TokenSource`; post-hoc gate emits `safety-*`; truncate/barge-in preserved |
| C8 | Cascaded adapter lifecycle | `kuralle-livekit-plugin/src/llm/KuralleRuntimeLLMAdapter.ts` | REQ-10, `aria_runtime_llm_adapter.test` | Uses `.delta`; handles cancel; TTFT fires on first delta |
| C9 | Update in-repo consumers/tests/examples | core + plugin tests, `examples/` | REQ-11 | `bun run test`, `bun run typecheck:all` green |
| C10 | Live smoke + docs + ADR 0004 | `examples/`, `apps/docs/`, READMEs, `docs/adr/0004-*.md` | REQ-9, success criteria | Runnable example shows >1 delta + cascaded TTFT improvement; docs state native-realtime caveat |
| C11 | Unified `0.4.0` version bump | all `package.json`, changeset | REQ-11 | `pnpm` graph versions together; CHANGELOG entry |

- [ ] **C1** types — `types/stream.ts`, `types/voice.ts`
- [ ] **C5** shared emitter — `runtime/channels/streaming/speakGated.ts`
- [ ] **C8** cascaded adapter — `KuralleRuntimeLLMAdapter.ts`

## 9. Validation and Testing

### 9.0 Validation Contract (assertion IDs)

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1 | §3 | ungated multi-token reply emits >1 `text-delta` before turn-end |
| REQ-2 | §3 | sentence-mode block emits cleared sentences, never the blocked sentence |
| REQ-3 | §3 | turn-mode (grounding) emits buffered; blocked content never appears |
| REQ-7 | §3 | exactly one `text-start`/`text-end` per turn; cancel-then-safe on late block |
| REQ-9 | §3 | native realtime turn-gate emits `safety-*` post-hoc; docs state advisory |
| REQ-10 | §3 | cascaded adapter consumes `.delta`; first chunk before `done` |
| test:speakGated.modes | §9.1 | fail-to-pass |
| test:aggregator.boundaries | §9.1 | fail-to-pass |
| cmd:typecheck-all | §9.3 | `bun run typecheck:all` succeeds |
| A-STREAM-1 | §9.3 | live smoke shows incremental deltas (observed) |

### 9.1 Fail-to-Pass Tests

- `mode.test` — `resolveStreamMode` returns `token`/`sentence`/`turn` for the matching gate configs; coarsest-wins.
- `aggregator.boundaries` — `SentenceAggregator` splits `"Hi there. How are you?"` into two; keeps `"$29.99 is the price."` intact; `flush()` returns trailing partial.
- `speakGated.modes` — token mode: N deltas for N tokens, one `text-start`/`text-end`; sentence mode with a policy blocking sentence 2: sentence 1 emitted, `text-cancel` + safe message, sentence 2 text never emitted; turn mode: zero deltas until end, then one buffered message; grounding block replaced.
- `aria_runtime_llm_adapter.test` (extend existing) — adapter maps `text-delta.delta` to chunks; `recordTtftOnce` fires on the first delta, not at `done`.

### 9.2 Regression Tests (Pass-to-Pass)

- `bun run test` (full core + plugin suites; all event-shape assertions updated for the lifecycle — breaking, expected).
- Existing flow/voice/extraction suites; `runExtraction` emits no text lifecycle (REQ-12).

### 9.3 Validation Commands

```bash
bun run build
bun run test
bun run typecheck:all

# Live smoke: assert more than one text-delta arrives and the first precedes turn-end.
bun run packages/kuralle-core/examples/<streaming-smoke>.ts | \
  grep -c '"type":"text-delta"'    # expect > 1 for a multi-token reply

# Cascaded TTFT: run the livekit ws cascaded e2e and confirm first chunk before turn completion
bun run packages/kuralle-livekit-plugin-transport-ws/test/e2e/ws-cascaded-e2e.ts
```

## 10. Security Considerations

- **Gate invariant (Kuralle-controlled boundaries):** in `sentence`/`turn` mode a blocking gate's rejected content is never emitted as a `text-delta`; therefore text consumers and cascaded TTS never receive blocked content. This is strictly equal to or stronger than today (today buffers; this RFC buffers only what the gate needs and gates each sentence before emit).
- **Native realtime caveat (REQ-9):** on the native realtime path the provider speaks audio before any Kuralle gate runs. Whole-answer content gates are **advisory** there — they truncate and correct but cannot prevent the audio already played. This is a pre-existing property of provider-native realtime, not introduced here; this RFC makes it explicit in docs and routes reliable control to input-side gating + tool authority. No new attack surface; the honest scoping reduces the risk of a false sense of safety.
- **No secret/PII handling change.** Redaction processors that must run before emit declare `streamGranularity: 'sentence'` (or `'turn'`) and gate accordingly; they never see less context than today.

## 11. Rollback and Abort Criteria

- **Abort if** sentence mode ever emits a blocked sentence's text (invariant breach) — hard stop, treat as failed; do not ship. Reproduce with `speakGated.modes` block case before proceeding.
- **Abort if** deltas arrive out of order or a turn emits more than one `text-start`/`text-end` pair (REQ-7 breach).
- **Abort if** cascaded TTFT does not improve (first chunk still at turn-end) — indicates the adapter or `speakGated` is still buffering; re-diagnose, do not paper over.
- **Rollback procedure:** this is a breaking protocol release; rollback = revert the `0.4.0` release commit and republish `0.3.x`. There is no runtime flag to toggle (REQ-11 — no compat layer by design), so rollback is at the release boundary, not per-call.

## 12. Open Questions

- **Q1: Sentence segmentation — hand-rolled util vs. dependency.** Tradeoff: a small dependency (e.g. a TS sentence splitter) is more robust on edge cases vs. a hand-rolled `matchEndOfSentence` keeps the dependency graph lean (a framework value — CLAUDE.md, "No source maps, lean publishes").
  **Proposal:** hand-rolled `matchEndOfSentence` (terminal punctuation + decimal/abbreviation lookahead, mirroring Pipecat `simple_text_aggregator.py:104-110`). No new dependency. Revisit only if real transcripts expose boundary failures the regex can't cover.

- **Q2: Default `streamGranularity` for policies that don't declare one.** Tradeoff: default `token`/`sentence` (faster, but an undeclared blocking gate could leak a sentence) vs. default `turn` (safe, but a gate author must opt in to stream).
  **Proposal:** default `turn`. Safe-by-default is the correct posture for a guardrail field; streaming is an explicit, reviewed opt-in by the gate author. Documented prominently so authors enable `sentence` where appropriate.

- **Q3: Native realtime whole-answer gate — keep post-hoc or disable.** Tradeoff: keep running it (advisory truncate + correction, may double-speak) vs. disable it on native realtime (no false sense of protection).
  **Proposal:** keep it, running post-hoc, emitting `safety-*`/`pipeline-validation-*` events and a correction utterance, with docs (REQ-9) stating it is advisory and that input-side gating is the reliable control. Disabling silently would hide a real signal; keeping it loud is more honest.

- **Q4: Versioning.** Tradeoff: 0.x breaking convention.
  **Proposal:** `0.4.0`, unified across all packages in one `pnpm publish -r` release (per the monorepo "version + publish together" gotcha, `CLAUDE.md`). Breaking-change notes in CHANGELOG; downstream consumers (e.g. external Studio web-ui) migrate `part.text` → `part.delta` + lifecycle.
