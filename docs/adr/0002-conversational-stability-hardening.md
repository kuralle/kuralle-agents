# ADR 0002 — Conversational-stability hardening (W1–W9)

**Status:** Accepted (2026-06-04)
**Context:** conversational-stability root-cause, validation, and implementation analysis (W1–W9).

## Context

Two root-cause workflows + a 4-use-case × 2-provider validation found Kuralle's instability for human-like, always-on conversation is **framework-level** (reproduces in every domain), driven by one keystone — **control is fused into generation** — plus concrete primitives. The two verified, highest-severity defects:
- **W1:** a tool exception (or a `maxOscillations` cap, or a model-initiated tool call with bad args) **aborts the whole session** — there is no turn-local recovery boundary; `classifyControl` knows only `handoff`/`final`; `Runtime` rethrows.
- **W9:** the **confirm-before-mutate gate fails *toward* mutating** — a decide node maps off-script text to `confirm` (books on a dessert question; opens a ticket on "no thanks"), and post-END messages re-mutate.

**Text is the primary primitive; voice is cascaded over text.** So endpointing (W7) is deferred; latency-masking via tool-execution-modes (W8) is kept because it is the substrate the cascaded-voice path rides on.

## Decisions

1. **Errors degrade, they never abort (W1).** Tool throws, validation throws, and oscillation caps are converted — *in the runtime/driver layer* — into a graceful in-turn outcome: a safe assistant message, an `error`/`tool-error` stream event, and routing to the flow's `escalate` target (or a graceful end + park) — never a rejected run handle. Add a `recover`/`escalate` control-result type. A per-tool/per-author `try/catch` is explicitly *not* the fix (validation proved it insufficient).
2. **Mutation gates are deterministic, not model-mapped (W9).** A node may be marked as a mutation/confirm gate; advancing past it requires a **deterministic explicit affirmative** (parsed in code), never an LLM-mapped choice; off-script input does not advance; post-END input never re-triggers a mutation.
3. **Context is scoped per node (W3), repair is observable (W5), digression is routable (W4), and the orchestrator is separable from generation (W2).** These follow the ElevenLabs separation principle: transitions/guardrails/routing run *around* generation, not inside it.
4. **Latency is masked by tool-execution modes (W8):** `immediate`+interim / `post_speech` / `async`, wiring the existing (currently-dead) `interim`/`interimAfterMs` fields; speculative generation deferred until W2 lands.
5. **Keep the deterministic virtues** already shipped (silent collect extraction, one-input-per-turn, base layer) — W1–W9 add resilience *without* reintroducing free-form narration or fabricated fields.
6. **Provider posture:** default `gpt-4.1-mini` (4 crashes, no fabrication, reliable choices) until W1+W9 land; `gemini-3.1-flash-lite` (14 crashes, fabrication, unsafe choice gates) is not production-safe on Kuralle until then.

## Consequences
- Pro: an action-taking agent can no longer be killed by a tool, and can no longer mutate without a real yes — the two trust-critical properties. Per-node scoping + repair + digression close the human-likeness gaps; W2 is the keystone that makes them clean.
- Con: W1 changes error semantics (callers that relied on a throwing session must adapt); W2 is a large refactor (sequenced last among the structural items, behind a flag if needed).
- Each W ships as its own `@kuralle-agents/core` patch with regression tests + a live re-run against the `kuralle-redteam-lab` agents.
