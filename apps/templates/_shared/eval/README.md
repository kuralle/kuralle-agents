# Live smoke testing — discipline + coverage matrix

This directory holds **live-LLM smoke tests** for the memory + compaction overhaul (PR #38). They complement the unit + mock-driven integration tests in `packages/kuralle-core/test/` — they do not replace them.

## Why we smoke test (the discipline)

The memory + compaction overhaul that introduced this directory landed with **763 unit tests passing**. The first live-LLM smoke run still surfaced **three real production bugs** that the unit suite did not catch:

1. `memory_block` tool was built but never registered on agents — the LLM had a system-prompt view of memory but no tool to write to it, so it HALLUCINATED success while the file stayed empty on disk
2. `force: true` on `compressNow` didn't bypass `needsCompaction` — manual `/compress` on a small session silently no-op'd, defeating the entire feature
3. `compressNow` returned `{compacted: false}` whenever the template didn't pre-configure `autoCompaction` (most templates don't)

None of these were findable from mocked LLMs because **mocks don't fail the way real LLMs + real users do**. The model in test 1 was not a regression — it was a never-worked-in-production primitive that the smoke test caught on its first live invocation.

**The rule going forward:** every PR that touches `packages/kuralle-core/src/runtime/`, `packages/kuralle-core/src/memory/`, or the hono-server should be smoke-tested via the script in this directory before claiming "done." If the change introduces a new tool, endpoint, or event type, the smoke script should grow a corresponding test.

## What runs today

### `pr-smoke-test.sh` — primary harness

Auto-loads `OPENAI_API_KEY` from the repo-root `.env`, boots `knowledge-worker` on a non-default port with a scratch memory dir, runs the smoke checks sequentially, kills the server, prints pass/fail.

```bash
bash apps/templates/_shared/eval/pr-smoke-test.sh
```

Cost: ~$0.05 per run against `gpt-4.1-mini`. Time: ~90 seconds.

| # | Test | Covers PRs |
|---|---|---|
| 1 | Basic chat (sanity) | PR-8 wiring + PR-3 observability stream |
| 2 | `memory_block` tool invocation | PR-5 tool registration + PR-6 merge semantics |
| 3 | USER.md on disk contains the fact | PR-5 atomic file writes + safety-bypass for safe content |
| 4 | Cross-session recall | PR-5 frozen-snapshot pattern + ContextAssembleStage injection |
| 5 | Memory isolation between users | PR-5 per-owner scoping |
| 6 | Safety scanner blocks injection | PR-5 `safetyScanner.ts` |
| 7 | `POST /api/session/:id/compress` with `force:true` | PR-13 endpoint + PR-3 debug payload |
| 8 | Compaction debug payload schema | PR-3 `CompactionDebugInfo` fields |
| 9 | Structured-checkpoint summary prefix lands | PR-9 injection-defense prefix |
| 10 | Three-phase pipeline stream events | Refinement + validation observability |

### `openai-compat-smoke.sh` — Vapi/ElevenLabs Custom-LLM compatibility

Validates that `POST /v1/chat/completions` speaks OpenAI's exact wire
format so voice platforms (Vapi, ElevenLabs Conversational AI, LiveKit
Agents, Telnyx Voice AI) can plug kuralle in as a Custom LLM
with zero adapter code on their side.

```bash
bash apps/templates/_shared/eval/openai-compat-smoke.sh
```

Cost: ~$0.02. Three tests:
1. Non-streaming POST returns OpenAI `chat.completion` shape
2. Streaming POST returns SSE chunks (`chat.completion.chunk` + `[DONE]`)
3. `X-Session-Id` header preserves session continuity across stateless
   Vapi/ElevenLabs-style turn requests

Research: no existing TS library does agent-runtime → OpenAI-compat
streaming properly (verified via gh search; precedents like
`arklexai/arksim` only implement the non-streaming half, which is
inadequate for low-latency voice). PR-20's `createOpenAICompatRouter`
fills the gap.

### `persona-smoke.sh` — persona wiring

Offline, deterministic smoke for first-class personas. It runs the real
Runtime with an `ai/test` mock model and verifies:
1. `persona-applied` events fire when a persona is configured
2. `agent-start` includes `personaName`
3. formal and warm personas produce distinct responses by sign-off and length

```bash
bash apps/templates/_shared/eval/persona-smoke.sh
```

Cost: $0. Time: <1 second.

#### Platform doc grounding

Session-id resolution is platform-aware (verified against actual docs,
not invented):

| Platform | What it sends | We extract via |
|---|---|---|
| Vapi | `body.call.id` (stable per phone call) | `body.call.id` → `vapi-<id>` |
| ElevenLabs CAI | `body.metadata.conversation_id` | `body.metadata.conversation_id` → `el-<id>` |
| LiveKit Agents | nothing — stateless | hash of `messages[0]` |
| Any | `X-Session-Id` header | overrides all of the above |

Without Vapi's `call.id` extraction, every Vapi turn would look like a
new kuralle session (because Vapi sends full history each turn → hash
grows). This is real; tested against the
[Vapi serverless reference impl](https://github.com/VapiAI/server-example-serverless-vercel/blob/master/api/custom-llm/openai-sse.ts).

#### How kuralle's multi-agent features map to the wire format

The OpenAI wire format is single-agent + single-conversation. It has
no first-class concept of triage, handoffs, flow nodes, or subagents.
kuralle keeps multi-agent state on the SERVER side; voice platforms
see one coherent conversation.

| kuralle feature | What the voice platform sees | UX OK for voice? |
|---|---|---|
| **routing agent (`triageMode: 'structured'`)** | Routing happens via streamObject BEFORE first text-delta. Single specialist streams text. | ✅ Yes — recommended for voice |
| **routing agent (`triageMode: 'llm'`)** | Primary agent emits text first ("Let me check…") then transfers. Voice user hears two voices mid-turn. | ❌ Avoid for voice — Runtime warns at boot if `voiceMode + triageMode:'llm'` |
| **flow agent (state-machine nodes)** | Each turn's `tools[]` reflects the current node's toolset. Normal OpenAI behavior. | ✅ Yes — tools array is per-request, not session-level |
| **Subagent via `Agent.asTool()`** | Manifests as a normal `tool_call` chunk → `tool_result` → continued assistant text. | ✅ Yes — this is OpenAI's native pattern |
| **Mid-conversation handoff** | Like `triageMode:'llm'` — primary emits then transfers. | ⚠️ Acceptable if handoff happens at turn boundary; bad mid-turn |

The PR-20b commit adds a Runtime boot-time warning when
`voiceMode: true` is combined with any agent that has
`triageMode: 'llm'` — wire-format compatibility is fine, but the
user-perceptible UX (voice changing mid-utterance) is not.

### `cross-session-memory.sh` — narrower regression script

The 30-second cross-session memory regression. Pre-dates `pr-smoke-test.sh`; kept because it's the cheapest signal possible for "memory still persists across sessions." Use when you're iterating on the memory layer specifically.

### `cedar-health/eval/run-evals.ts` — broader multi-agent eval

9 cedar-health scenarios × N=5 runs covering multi-agent routing, identity verification, emergency short-circuit, Rx flow, etc. Run from the template directory:

```bash
cd apps/templates/cedar-health
pnpm eval
```

The original run (before this PR) found 38/45 pass + a real 129s hang. PR-1b's per-turn timeout should make the hang scenario emit a structured `turn-timeout` event instead. The full re-run validates that none of the reliability work regressed multi-agent flow.

## What's NOT yet smoke-tested (honest gaps)

Each of these has unit + mock coverage but **no live-LLM verification**. Most need a specific environment we don't currently force in CI. Tracking them here so they don't fall out of memory.

| PR | Capability | Why not yet smoked | What would prove it |
|---|---|---|---|
| **PR-1** | Context-overflow recovery (auto strip + retry) | Needs a real provider 400 — can't force without a >128k-token message | Use OpenAI `gpt-4o-mini` (8k context) and a fixture conversation that exceeds it. Assert: `context-overflow-recovered` event fires, turn completes on retry. |
| **PR-1b** | Per-turn timeout + zero-token-stream guard | Needs a real provider hang — not reproducible on demand | Mock a slow-network egress (e.g. via `mitmproxy`) and verify `turn-timeout` event with `kind: 'zero-token'` fires within `zeroTokenTimeoutMs`. |
| **PR-7** | `factTtlSeconds` eviction | Needs time-travel or a session that lives >TTL | Set `factTtlSeconds: 5`, write a fact, `await sleep(6000)`, send a new turn, assert the fact is no longer in the system prompt. |
| **PR-10** | Pre-LLM prune: dedup + image-strip | Needs a tool-heavy session with image attachments | Drive a session with 5× identical `read_file` results + a base64 screenshot; assert post-compaction tokensBefore/tokensAfter shrink ratio is in the expected range. |
| **PR-11** | Split-turn alignment | Needs a forced-long session crossing turn boundaries | Drive 60 turns of mixed user+assistant+tool messages; assert the post-compaction `messages[1]` is always `role: 'user'` (never mid-turn assistant). |
| **PR-14** | Anthropic prompt cache (`system_and_3`) | Needs a Claude key | Send 3 turns against `claude-haiku-4-5`; assert `cacheReadInputTokens > 0` on turn 2 from `result.providerMetadata.anthropic`. |
| **PR-15** | Per-task auxiliary models (`auxiliaryModels.compression`) | Needs distinct providers configured | Configure `defaultModel: gpt-4o-mini`, `auxiliaryModels.compression: gpt-4o-mini` with a distinct API key/header; trigger compaction; assert the compression call used the aux key (proxy/log inspection). |
| **PR-9** UPDATE prompt path | Cumulative summaries across many compactions | Needs a session long enough to compact ≥2 times | Drive a 200-turn session with autoCompaction `maxMessages: 50`; assert the second compaction's system message contains both old and new completed-actions entries (no information loss across the boundary). |

## How to add a new smoke test

1. Pick a representative template — `knowledge-worker` for memory + single-agent stuff, `cedar-health` for multi-agent / handoff
2. Append a new `=== Test N: ... ===` block to `pr-smoke-test.sh`
3. Use the existing helpers: `send_turn`, `extract_text`, `record_pass`, `record_fail`
4. Reference the PR(s) the test covers in the test name (e.g. `(PR-1 overflow recovery)`)
5. Re-run the full harness to confirm pass + no regression on the other 9 tests
6. Document the new test in the table above

For tests that need specific config (low TTL, low maxMessages, etc.), prefer:
- A dedicated test-only template under `apps/templates/__smoke-<feature>/` rather than mutating the public templates, OR
- An env var the public template reads at boot (e.g. `KW_FACT_TTL_SECONDS` — only set when smoke-testing)

## Cost summary

| Harness | Cost / run | Time |
|---|---|---|
| `pr-smoke-test.sh` | ~$0.05 | ~90s |
| `cross-session-memory.sh` | ~$0.001 | ~30s |
| cedar-health 9×5 eval | ~$0.05 | ~5 min |
| **Total per full smoke** | **~$0.10** | **~7 min** |

Cheap enough to run pre-merge on every PR that touches the runtime / memory / compaction layers.
