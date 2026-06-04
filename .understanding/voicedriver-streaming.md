# Understanding: VoiceDriver transcript streaming + barge-in + gate path

## Frame
This map unlocks Sprint 2 stories S2-01 (transcript `TokenSource`) and S2-02 (honest post-hoc gate). It locates every assistant-text emit site, the barge-in/truncate state machine, and the gate call site in `VoiceDriver.runAgentTurn`, then traces downward into `RealtimeAudioClient` transcript emission granularity and upward through `applyPostTurnPolicies`. The core deliverable for Sprint 2: a clear statement of WHERE incremental `text-delta`s should be produced, WHERE the post-hoc gate fits, and WHY the "never emit blocked content" invariant cannot hold for native realtime audio (REQ-9).

## Primitive (first principles)
The assistant transcript stream flows from the provider (`RealtimeAudioClient`) → `VoiceDriver.onTranscript(text, 'assistant')` → accumulation into `draftText` + `heardCharCount` → post-turn gate → single-shot emit. The transcript arrives in **whole-utterance or per-part chunks** (not token-level deltas); `heardCharCount` counts characters the provider reported as spoken; `truncateAt` freezes that count at interrupt time; `truncateToHeard(draftText, heardChars)` produces the heard prefix. Audio leaves Kuralle's control before any gate runs — the provider emits PCM directly to the transport.

## Top-down map

### Layer 1 — System boundary
**`VoiceCallSession.start()`** (`packages/kuralle-realtime-audio/src/VoiceCallSession.ts:30-71`) is the entry point. It wires the transport ↔ modelClient audio relay (lines 51-58) and calls `runtime.run({ driver: new VoiceDriver({ client: modelClient }) })` (line 63-70).

### Layer 2 — Channel driver: VoiceDriver
**`VoiceDriver.runAgentTurn()`** (`packages/kuralle-core/src/runtime/channels/VoiceDriver.ts:42-115`)

- **Pre-turn gate** (lines 46-56): `applyPreTurnPolicies(ctx)` — if blocked, emits a one-shot `text-start/delta/end` + `turn-end`. Returns early.
- **Grounding + tool prep** (lines 58-68): `runGatherPhase`, tool resolution, `reconfigure()`.
- **Provider turn loop** (lines 70-93): Iterates `collectProviderTurn(ctx, ...)` up to `maxSteps` times.
  - `draftText += assistantText` (line 79) — accumulates provider text.
  - **Interrupt path** (lines 80-92): If `outcome === 'interrupted'`, sets `out.truncateAt = this.heardCharCount`, computes `truncateToHeard(draftText, heardCharCount)`, emits the truncated prefix as a single trio, emits `turn-end`, returns.
  - **Tool loop** (lines 95-97): Continues if tools were called and not complete.
- **Post-turn gate** (line 99): `applyPostTurnPolicies(ctx, draftText, toolCallsMade, citations)`.
- **Emit** (lines 100-113): Takes `postTurn.text` (which may be a blocked message), emits as a single `text-start/delta/end` + `turn-end`.

### Layer 3 — Provider turn collection
**`VoiceDriver.collectProviderTurn()`** (`VoiceDriver.ts:160-260`)

This is a Promise that wraps the event-driven provider protocol. Key state within the closure:

| Variable | Lines | Role |
|----------|-------|------|
| `assistantText` | 170 | Local accumulator for this turn's assistant text |
| `settled` | 171 | Prevents double-resolve |
| `sawInterrupt` | 172 | Set true on `interrupted`/`abort` |

Event handlers in the Promise:

- **`onTranscript(text, 'assistant')`** (line 181-185): `assistantText += text; this.heardCharCount += text.length`
- **`onTranscript(text, 'user')`** (line 186-188): Stores user barge-in text only if interrupt already seen → `this.pendingBargeInInput = text`
- **`onToolCall`** (line 190-214): Async — executes tools via `executeModelToolCall`, emits `tool-call`/`tool-result` stream events, sends results to provider
- **`onTurnComplete`** (line 216-218): Resolves with `'interrupted'` if `sawInterrupt`, else `'complete'`
- **`onInterrupted`** (line 220-223): Sets `sawInterrupt = true`, `out.truncateAt = this.heardCharCount`
- **`onError`** (line 225-228): Emits error, rejects Promise
- **`onAbort`** (line 230-235): Same as interrupted — sets `sawInterrupt`, `truncateAt`, resolves `'interrupted'`

### Layer 4 — Provider client (RealtimeAudioClient implementations)

Three implementations exist, differing in transcript granularity:

#### GeminiLiveSession (Node)
**File:** `packages/kuralle-realtime-audio/src/node/GeminiLiveSession.ts`

Transcript is emitted through **two** paths within `handleServerMessage()`:

1. **In-turn text parts** (lines 309-320): `serverContent.modelTurn.parts[].text` — each text-bearing part in the model turn is emitted individually:
   ```
   this.emitEvent('transcript', part.text, 'assistant');  // line 319
   ```
   **Granularity: per-model-turn-part** — Gemini may emit multiple `modelTurn` messages during a turn, each with parts containing text. This yields multiple transcript events per turn.

2. **Output transcription** (lines 323-328): `serverContent.outputTranscription.text` — the final/cumulative transcription:
   ```
   this.emitEvent('transcript', text, 'assistant');  // line 327
   ```
   **Granularity: whole-utterance (cumulative)** — the complete assistant text at that point.

3. **Audio** (lines 310-316): `serverContent.modelTurn.parts[].inlineData.data` — decoded and emitted as `audio` (`this.emitEvent('audio', audioData)`). This is **independent** of transcript — the audio reaches the transport before any Kuralle gate.

#### CloudflareGeminiLive (Workers)
**File:** `packages/kuralle-realtime-audio/src/cloudflare/gemini-live.ts:409-417`

Simpler — only `outputTranscription.text` is emitted per `serverContent` frame:
```
if (it) this.emit('transcript', it, 'user');       // line 410
if (ot) this.emit('transcript', ot, 'assistant');   // line 412
```
**Granularity: per-frame whole-utterance** — cumulative transcription per serverContent message.

#### OpenAIRealtimeClient (Node)
**File:** `packages/kuralle-realtime-audio/src/openai/OpenAIRealtimeClient.ts:215-221`

Single event at turn-end:
```ts
case 'response.audio_transcript.done': {
  const transcript = data.transcript as string | undefined;
  if (transcript) this.emit('transcript', transcript, 'assistant');
  break;
}
```
**Granularity: one whole-utterance at turn-end** — not incremental. The `input_audio_buffer.speech_started` event (line 224-227) is the barge-in signal.

### Layer 5 — Audio → transport (REQ-9 evidence)

**`VoiceCallSession`** (`packages/kuralle-realtime-audio/src/VoiceCallSession.ts:51-54`):
```ts
modelClient.on('audio', (data: Uint8Array) => {
  if (this.aborted) return;
  transport.sendAudio(data);
});
```

Audio flows directly from the provider to the transport. There is no gating, no buffering, no Kuralle interception. The `transport.sendAudio(data)` call (line 53) happens synchronously on the `audio` event. **Kuralle does not control the audio emission boundary for native realtime.**

### Layer 6 — Post-turn gate chain

**`applyPostTurnPolicies()`** (`packages/kuralle-core/src/runtime/policies/agentTurn.ts:237-270`):
1. Runs output processors (`runOutputProcessors`, line 243) — may block or rewrite
2. Runs validation policies (`runValidationPolicies`, line 267) — may block, escalate, or rewrite
3. Block decisions produce `safety-blocked` audit events via `recordValidationDecision` (line 63-85)
4. Returns `PostTurnResult { proceed, text, blockedMessage, control, confidence }`

The gate does NOT emit `HarnessStreamPart` events like `safety-blocked` or `pipeline-validation-block` — those exist in the type union (`voice.ts:285-303`) but are emitted elsewhere (by the hook system or the policy loop itself). For Sprint 2's post-hoc gate, we'd emit these events in `VoiceDriver` after the gate result is known.

## Bottom-up trace

### Atomic unit: `onTranscript(text, 'assistant')` event

**Caller chain (bottom → top):**

1. **Provider emits event** — e.g., `GeminiLiveSession.ts:319` calls `this.emitEvent('transcript', part.text, 'assistant')`
2. **`RealtimeEventMap`** (`RealtimeAudioClient.ts:112-113`): typed as `transcript: (text: string, role: 'user' | 'assistant') => void`
3. **`VoiceDriver.collectProviderTurn`** (`VoiceDriver.ts:181-185`): `onTranscript` handler accumulates `assistantText += text` and `this.heardCharCount += text.length`
4. **Resolution** (`VoiceDriver.ts:216-218`): `onTurnComplete` resolves the Promise with `{ outcome, assistantText }`
5. **Caller** (`VoiceDriver.ts:75-79`): `draftText += assistantText`, check outcome
6. **Gate** (`VoiceDriver.ts:99`): `applyPostTurnPolicies(ctx, draftText, ...)`
7. **Emit** (`VoiceDriver.ts:107-113`): single `text-start/delta/end` trio
8. **Consumer** (`VoiceCallSession.ts:63-70`): `runtime.run()` returns `TurnHandle` with `.events` AsyncIterable

### Barge-in trace (bottom → top)

1. **Provider emits `interrupted`** — `GeminiLiveSession.ts:338` (`message.serverContent.interrupted`) or `OpenAIRealtimeClient.ts:224-227` (`input_audio_buffer.speech_started`)
2. **`VoiceDriver.onInterrupted`** (`VoiceDriver.ts:220-223`): `sawInterrupt = true`, `out.truncateAt = this.heardCharCount`
3. **`onTurnComplete`** fires (`VoiceDriver.ts:216-218`): resolves with `'interrupted'`
4. **Back in `runAgentTurn`** (`VoiceDriver.ts:84-92`):
   - `out.truncateAt = this.heardCharCount` (line 85) — redundant with line 224 but safe
   - `out.text = truncateToHeard(draftText, this.heardCharCount)` (line 86)
   - Emit truncated prefix as trio + turn-end (lines 87-91)
5. **`awaitUser`** (`VoiceDriver.ts:137-143`): checks `pendingBargeInInput` (populated by `onTranscript` for user role after interrupt, line 186-188) — returns the barge-in user text

### Invariants

1. **`heardCharCount`** is monotonic — only incremented, never decremented. Set to 0 at turn start (line 69).
2. **`truncateAt`** freezes `heardCharCount` at interrupt time. Two assignment sites (lines 85, 224) — both set to the same value, ensuring the heard prefix is correct regardless of whether `onTurnComplete` fires before `onInterrupted` or vice versa.
3. **`truncateToHeard(draftText, heardChars)`** (`VoiceDriver.ts:308-320`): returns a prefix of `draftText` truncated to `heardChars` characters, breaking at a word boundary if >60% through the word. Guarantees the returned text was actually heard.
4. **`pendingBargeInInput`** stores user barge-in text — consumed once by `awaitUser` (line 137-143) which nulls it. The user transcript arrives AFTER the interrupt (line 186-188 checks `sawInterrupt` first).
5. **Audio bypasses Kuralle** — `RealtimeAudioClient.emit('audio', data)` → `VoiceCallSession.transport.sendAudio(data)` is synchronous and ungated.

## Reconciliation

### Agreements (high confidence)

| Claim | Top-down | Bottom-up | Evidence |
|-------|----------|-----------|----------|
| Transcript arrives as whole-utterance/per-part chunks, not token deltas | Gemini parts + outputTranscription; OpenAI single `audio_transcript.done` | `onTranscript` accumulates character-by-character via `assistantText += text` — the `text` is a full string per event, not incremental | `GeminiLiveSession.ts:319,327`, `OpenAIRealtimeClient.ts:219`, `VoiceDriver.ts:183` |
| `heardCharCount` counts characters the provider told us it spoke | Tracks `text.length` per transcript event | Always `this.heardCharCount += text.length` (line 184) | `VoiceDriver.ts:184` |
| Barge-in truncates to `heardCharCount` | `truncateAt = this.heardCharCount` on interrupt; `truncateToHeard` produces prefix | `onInterrupted` sets `truncateAt`; `runAgentTurn` uses it for the emit | `VoiceDriver.ts:85-86, 222-224` |
| Post-turn gate runs once on full `draftText` | `applyPostTurnPolicies(ctx, draftText, ...)` at line 99 | Gate receives complete accumulated text from all provider turns | `VoiceDriver.ts:99` |
| Audio leaves Kuralle's control before any gate | `modelClient.on('audio')` → `transport.sendAudio()` — no gate between provider and transport | Provider emits audio independently; VoiceDriver only sees transcript events | `VoiceCallSession.ts:51-54`, `GeminiLiveSession.ts:313-316` |
| `waitForUserTurn` (second loop, lines 281-301) is user-only, non-speaking | Used by `awaitUser` for field extraction | Only accumulates `role === 'user'` transcripts, resolves with user text, no text lifecycle events | `VoiceDriver.ts:281-301, 132-133` |

### Divergences

| Point | Top-down view | Bottom-up view | Resolution |
|-------|---------------|----------------|------------|
| Emit-site count for the "normal" path | The gate result is emitted once as a trio (lines 107-113) | `speakGated` would stream the gate result as a trio too (since transcript is whole-utterance, not token deltas) | Both agree the current path produces one trio. The `TokenSource` will yield whole-utterance chunks from `onTranscript`, so `speakGated` in `token` mode will emit each chunk as it arrives (for Gemini: multiple; for OpenAI: one). In `sentence` mode, `SentenceAggregator` further splits whole-utterance chunks into sentences. **No conflict — the TokenSource granularity matches the provider: per-chunk, not per-token.** |
| Where the post-hoc gate emits `safety-*` events | After `applyPostTurnPolicies` returns (line 99-113) | The gate callback in `speakGated` would return `GateOutcome` and `speakGated` would emit the appropriate lifecycle | Both agree the gate runs post-hoc. The question is: should `speakGated` emit `safety-*`/`pipeline-validation-*` events on block, or should VoiceDriver emit them after `speakGated` returns? **Recommendation:** `speakGated` handles the text lifecycle; VoiceDriver emits the safety/pipeline events post-hoc alongside the provider interrupt + correction. |

### Confidence summary

| Section | Confidence | Gap |
|---------|------------|-----|
| Transcript granularity | **high** | Three provider implementations examined; all produce whole-string events |
| Barge-in state machine | **high** | Both test suites (`conformance.test.ts` G3, `bargein.test.ts`) verify the invariant |
| Audio independence | **high** | `VoiceCallSession.ts:51-54` shows direct audio relay without gating |
| Gate call site | **high** | Single unambiguous call at `VoiceDriver.ts:99` |
| Post-hoc gate placement | **high** | Clear that `speakGated` runs after provider audio; need to decide where safety events are emitted |

## Data & control flow

```
Provider (Gemini/OpenAI)
  │
  ├─► 'audio' event ───► VoiceCallSession.transport.sendAudio(data)  [independent of Kuralle gate]
  │
  ├─► 'transcript'(text, 'assistant') ───► VoiceDriver.onTranscript
  │     │                                      │
  │     │  ┌───────────────────────────────────┘
  │     │  │ assistantText += text
  │     │  │ heardCharCount += text.length
  │     │  ▼
  │     │  (multiple events accumulate into assistantText)
  │     │
  │     ├─► 'interrupted' ───► VoiceDriver.onInterrupted
  │     │     │                    │ sawInterrupt = true
  │     │     │                    │ truncateAt = heardCharCount
  │     │     │                    ▼
  │     │     │              ┌───┐
  │     │     ▼              │
  │     ├─► 'turn-complete' ─┤ outcome = 'interrupted' | 'complete'
  │     │                    │
  │     ▼                    ▼
  │  collectProviderTurn resolves
  │     │
  ▼     ▼
VoiceDriver.runAgentTurn
  │
  ├─► if interrupted:
  │     truncateAt = heardCharCount
  │     text = truncateToHeard(draftText, heardCharCount)
  │     emit text-start/delta{truncated}/end + turn-end
  │     RETURN
  │
  ├─► applyPostTurnPolicies(ctx, draftText, ...)
  │     │  result may block (safe message) or proceed (original text)
  │     ▼
  │  emit text-start/delta{result}/end + turn-end
  │
  └─► ctx.emit → TurnHandle.events → consumers (SSE, cascaded adapter)
```

## Coupling & dependencies

| Dependency | Category | Files |
|------------|----------|-------|
| `RealtimeAudioClient` — `on('transcript')`, `on('interrupted')`, `on('turn-complete')`, `on('tool-call')` | **cross-process** (WebSocket) | `VoiceDriver.ts:248-252` |
| `ctx.emit` — stream events | **schema** | `VoiceDriver.ts:48-51,87-91,107-113` |
| `applyPreTurnPolicies` / `applyPostTurnPolicies` | **config** (policy chain) | `VoiceDriver.ts:46,99` |
| `ctx.bargeIn?.addEventListener('abort')` | **cross-process** (signal) | `VoiceDriver.ts:253` |
| `ctx.abortSignal?.addEventListener('abort')` | **cross-process** (signal) | `VoiceDriver.ts:254` |
| `this.client.reconfigure()` / `requestResponse()` | **cross-process** (WS reconfigure) | `VoiceDriver.ts:71,255` |
| `runSilentExtraction` — extraction path | **config** (uses text model, not voice) | `VoiceDriver.ts:132-133` |
| `resolveVoiceGeminiTools` — tool schema transformation | **schema** | `VoiceDriver.ts:62` |
| `speakGated` / `TokenSource` — **Sprint 2 integration point** | **schema** (new) | RFC §5.1, REQ-8 |

## Domain vocabulary

| Term | Definition | Source |
|------|-----------|--------|
| `draftText` | Full accumulated assistant text across all provider turns in this agent turn | `VoiceDriver.ts:69` |
| `heardCharCount` | Running count of assistant-text characters reported by the provider via `onTranscript` | `VoiceDriver.ts:29,69,184` |
| `truncateAt` | Snapshot of `heardCharCount` frozen at interrupt time — tells consumers where to cut | `VoiceDriver.ts:85,224` |
| `truncateToHeard(text, heardChars)` | Function returning the prefix of `text` that was definitely heard, with word-boundary cleanup | `VoiceDriver.ts:308-320` |
| `pendingBargeInInput` | User text that arrived after an interrupt — consumed by `awaitUser` | `VoiceDriver.ts:30,186-188,137-143` |
| `collectProviderTurn` | Promise-based wrapper around the event-driven provider protocol — accumulates everything from `requestResponse` to `turn-complete` | `VoiceDriver.ts:160-260` |
| `waitForUserTurn` | Promise-based wrapper that collects ONLY user transcripts — used for field extraction (non-speaking, REQ-12) | `VoiceDriver.ts:268-305` |
| `reconfigure()` | Updates provider systemInstruction/tools mid-session (full WS reconnect, preserving resumption handle for continuity) | `VoiceDriver.ts:148-150` |
| `outputTranscription` | Gemini's final/cumulative transcription text per `serverContent` frame | `GeminiLiveSession.ts:324` |
| `audio_transcript.done` | OpenAI's single whole-utterance transcription at turn-end | `OpenAIRealtimeClient.ts:215` |
| `modelTurn.parts[].text` | Gemini's in-turn text parts — may arrive multiple times during a turn | `GeminiLiveSession.ts:317` |

## Tribal knowledge

- **Gemini emits transcript through two paths** (`GeminiLiveSession.ts:309-328`): `modelTurn.parts[].text` (per-part, during turn) AND `outputTranscription.text` (cumulative, per frame). Both are forwarded to the same `onTranscript` handler. This means a VoiceDriver listener may see multiple transcript events for the same text (the part-level text, then the cumulative outputTranscription). The current `assistantText += text` accumulation would **double-count** if both paths fire for the same content. However, in practice, the Gemini Live API seems to emit parts OR outputTranscription, not both for the same segment — the parts carry text for TEXT-only mode, while outputTranscription carries the speech-to-text result.
- **`onTranscription` granularity varies by provider and mode**: Gemini with `outputAudioTranscription: {}` (set in `GeminiLiveSession.ts:192`) enables transcription output. OpenAI always sends `audio_transcript.done` at turn-end if transcription is enabled. CF Gemini emits per-frame outputTranscription.
- **`this.reconfigure()` causes a full WebSocket reconnect** (`GeminiLiveSession.ts:279-303`): it disconnects and reconnects, preserving `resumptionHandle` for continuity. The `_reconfiguring` / `_awaitingReconfigureOpen` flags suppress spurious `disconnected` events during the cycle. This is important because `VoiceDriver.runAgentTurn` calls `reconfigure` **before** `collectProviderTurn` (line 71) — so the voice session is briefly disconnected between turns during flow transitions.
- **OpenAI barge-in is `input_audio_buffer.speech_started`** — not `interrupted` like Gemini. Both are mapped to the same `RealtimeEventMap.interrupted` event. The `FakeRealtimeAudioClient.injectBargeIn` emits both `transcript(assistant)` for the partial text, then `interrupted`, then `transcript(user)`, then `turn-complete` — modeling the Gemini behavior.
- **`truncateToHeard` has a word-boundary heuristic** (lines 315-319): if the last space in the truncated text is beyond 60% of `heardChars`, it breaks at that space. This avoids mid-word truncation. If there's no good word boundary, it returns the raw slice.
- **S1-01 already flipped VoiceDriver emits to the new lifecycle** (`text-start/delta{id,delta}/end`), but they are still single-shot (one trio per turn). Sprint 2 replaces this with `speakGated` which emits multiple deltas for multi-chunk transcripts.

## Open questions

| ID | Question | Would resolve if |
|----|----------|------------------|
| O1 | Does Gemini's `outputTranscription.text` overlap with `modelTurn.parts[].text` in `outputAudioTranscription` mode? (Double-counting risk) | Run a live Gemini turn with `outputAudioTranscription: {}` and log every `transcript(assistant)` event — if both paths fire for the same text, the `TokenSource` must deduplicate or use only one path |
| O2 | Does `safety-blocked` / `pipeline-validation-block` event emission belong in `speakGated` (shared path) or in `VoiceDriver` (post-hoc only)? | The RFC §10 says "emit the relevant `safety-*` / `pipeline-validation-*` events and, on block, trigger the provider interrupt + correction utterance" — this suggests VoiceDriver-specific code after `speakGated` returns, since triggering a provider interrupt is voice-specific |
| O3 | What event triggers the "correction utterance" after a post-hoc gate block? `requestResponse(correctionText)` or `sendClientContent`? | Test: after `applyPostTurnPolicies` returns a block, call `this.client.requestResponse(safeMessage)` and verify the provider speaks the correction; check if `requestResponse` resets the turn state correctly |

## S2-01 Recommendation: TokenSource shape

The `TokenSource` adapter over `onTranscript` should:

```ts
function transcriptTokenSource(
  collectProviderTurn: (ctx, out, trigger, ...) => Promise<{ outcome, assistantText }>
): TokenSource {
  // Yield each onTranscript('assistant') chunk as a { delta: string }.
  // For Gemini: yields per-modelTurn-part text + outputTranscription.
  // For OpenAI: yields one chunk at turn-end.
  // The TokenSource MUST NOT accumulate — accumulation is speakGated's job.
}
```

**BUT** the current `collectProviderTurn` is a Promise that resolves with the complete `assistantText`. To make it a `TokenSource`, we need one of two approaches:

**Approach A (Recommended): Push-based → pull adapter**
Pass a callback that fires per transcript delta, bridging the event-driven `onTranscript` into the `AsyncIterator` expected by `speakGated`:

```ts
// Inside VoiceDriver.collectProviderTurn (refactored):
// Instead of accumulating, push each delta into a queue that speakGated pulls from.
// The Promise still resolves at turn-complete, but deltas are yielded as they arrive.
```

**Approach B: Restructure `collectProviderTurn` to return a `TokenSource` directly**
Make `collectProviderTurn` return `{ tokenSource: TokenSource, waitForCompletion: Promise<CollectOutcome> }`. The `tokenSource` yields deltas as they arrive; `waitForCompletion` resolves when the turn ends.

**Recommendation: Approach A** — least invasive. Create a `createDeferredTokenSource()` helper that returns `{ source: TokenSource, push: (delta: string) => void, close: () => void }`. Wire `onTranscript('assistant')` → `push(text)`; `onTurnComplete`/`onInterrupted` → `close()`. Feed `source` to `speakGated`.

## S2-02 Recommendation: Post-hoc gate placement

After `speakGated` returns, check `outcome.control` (or a separate gate result). If the gate blocked:

1. **Emit `safety-blocked` event** (`ctx.emit({ type: 'safety-blocked', moderator: 'post-turn-gate', ... })`)
2. **Emit `pipeline-validation-block` event** if applicable
3. **Trigger provider interrupt + correction:**
   ```ts
   // The provider may have already finished speaking. Send a correction utterance.
   // For Gemini: this.client.sendClientContent({ turns: [{ role: 'user', parts: [{ text: correctionText }] }] })
   // Or: this.client.requestResponse(correctionText)
   ```
4. **The emitted text** from `speakGated` already contains the safe message (since `speakGated` emits the gate result as the turn text). So the consumer sees the safe text in the stream AND the `safety-blocked` event as context.
5. **Document the constraint** in the README: "Whole-answer content gates are advisory on native realtime audio. The provider speaks audio before any Kuralle gate runs. On block, the gate emits a safety event and a correction utterance, but it cannot un-speak audio already played."

## REQ-9 Honest-Framing Statement

**The "never emit blocked content" invariant CANNOT hold for native realtime audio.**

Evidence:
1. `GeminiLiveSession.ts:313-316` — audio PCM data is emitted via `this.emitEvent('audio', audioData)` directly to the transport
2. `VoiceCallSession.ts:51-54` — audio is forwarded `transport.sendAudio(data)` with no gating
3. `VoiceDriver.ts:99` — `applyPostTurnPolicies` runs AFTER `collectProviderTurn` resolves, which is AFTER all audio has been spoken
4. The `onTranscript` handler (`VoiceDriver.ts:181-185`) sees the transcript but cannot prevent the audio that has already been sent

The post-hoc gate (S2-02) provides a **correction mechanism** — it emits safety events and speaks a correction — but it is ADVISORY, not preventive. The reliable controls on native realtime are:
- **Input-side gating** (pre-turn policies, `VoiceDriver.ts:46`)
- **Tool authority** (tools return data, not conversational text; flow control comes from node transitions)
- **Structured triage** (`routing: { mode: 'structured' }` — dispatch never leaks to the user)

## Confidence summary

| Section | Confidence | Gap |
|---------|------------|-----|
| Transcript granularity (per-provider) | **high** | Three implementations examined; Gemini emits per-part + cumulative, OpenAI emits one at end, CF emits per-frame |
| Emit sites in runAgentTurn | **high** | All four emit sites located with file:line |
| Barge-in state machine | **high** | Invariant verified by both test suites + code tracing |
| Post-hoc gate placement | **high** | `applyPostTurnPolicies` call site unambiguous; S2-02 recommendation concrete |
| Second transcript loop (waitForUserTurn) | **high** | Confirmed non-speaking, user-only, must NOT route through speakGated |
| REQ-9 evidence (audio independence) | **high** | `GeminiLiveSession.ts:313-316` + `VoiceCallSession.ts:51-54` — audio bypasses Kuralle |
| TokenSource shape recommendation | **medium** | Approach A (push-to-pull adapter) is least invasive but needs `createDeferredTokenSource` helper; O1 (Gemini double-fire risk) could affect dedup logic |
| Provider interrupt + correction mechanism | **medium** | `requestResponse` exists on Gemini client but its behavior after a completed turn needs testing (O3) |
