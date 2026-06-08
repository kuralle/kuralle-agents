# ADR 0007 — Derived host routing (no routing modes)

**Status:** Accepted · **Date:** 2026-06-08 · **Supersedes (in part):** the structured host selector (`runtime/select.ts` `selectHostTarget`) as the default routing path, and the `RoutingPolicy.mode` enum introduced experimentally on branch `feat/routing-mode-tools-enter-flow`.

## Context

An agent with ≥2 flows (or any routes) runs a per-turn **host selector** — a `generateObject` call in `runtime/select.ts` (`selectHostTarget`) — on **every non-flow "keep" turn**, just to decide `enterFlow | route | keep`. This is an always-on tax that blows the ~800–1000ms voice-to-voice budget. In-flow resume turns skip it (`run.activeFlow` short-circuits in `hostLoop.ts`), proving the selector — not RAG or skills — is the dominant keep-turn cost. Measured (sibling repo `syrinx`, `kuralle-full-findings.md`): T1 keep-turn TTFT **2874ms** with only 301ms of RAG.

We prototyped an opt-in `routing.mode: 'tools'` that folds flow entry into the speaking turn via an `enter_flow` control tool (the handoff-as-tool pattern used by OpenAI Agents SDK, LiveKit, and Pipecat). An A/B smoke (`examples/flows/routing-mode-ttft-smoke.ts`, bare 2-flow agent, gpt-4.1-mini, selector isolated) measured keep-turn TTFT dropping from **~2.8s → ~0.9s (≈3× across 3 runs)**, and the legacy selector **mis-routed** a Q&A keep turn into a flow on every run while tools-mode answered correctly. Two external review rounds (codex, high reasoning — `.handoff/wbs-routing-architecture.md`, `.handoff/wbs-routing-modes.md`) confirmed the direction and sharpened it.

Two constraints shaped the decision:

1. **Model-reasoned routing only — no lexical routing on the hot path.** `select.ts` currently contains `deterministicRouteMatch` and `keywordRouteFallback`, which tokenize `route.when` with `/[^a-z0-9]+/` and substring-match. These (and any keyword-table or embedding-prototype substitute) encode a **language-specific lexical surface** and break multilingual voice routing — paraphrases and non-English input the model could reason over are missed. We serve multilingual voice; the router must reason over semantic descriptions, never over lexemes.
2. **A mode menu is a permanent fork.** A public `routing.mode: 'tools' | 'structured' | 'llm'` enum multiplies every other feature's test matrix (RAG × mode, skills × mode, memory × mode, voice × mode) and contradicts Kuralle's core rule — *behavior is derived from which fields you populate* (`defineAgent`: `flows[]` → flow agent, `routes`+`routing` → triage, `agents[]` → composition).

## Decision

**One routing mechanism. No public routing modes. Behavior is derived from `(agent shape × driver output capability)`.**

### A. Derive the shape, don't configure a mode
A runtime helper `deriveAgentShape(agent)` classifies the agent:

- `hasLocalAnsweringSurface` — `instructions` populated (non-empty string, or a function/`AgentPrompt`), **or** any of `tools` / `globalTools` / `knowledge` / `memory` / `skills` / `workspace`. *Generated fallback instructions do **not** count.* `name`/`description`/`model`/`controlModel`/`routing`/`validate`/`refine`/`guardrails`/`limits` do not count.
- `hasLocalProcedure` — `flows.length > 0`.
- `hasDispatchTargets` — any of `routes` (agent or local-flow target), `agents`, `handoffs`.
- **`isAnsweringAgent`** = `hasLocalProcedure || hasLocalAnsweringSurface`.
- **`isPureDispatcher`** = `hasDispatchTargets && !isAnsweringAgent`.

### B. Two derived behaviors
- **Answering agent** → host-control tools folded into the speaking turn: `enter_flow({ flowName, reason })` for available (uncompleted, non-active) local flows, and `transfer_to_agent({ targetAgentId, reason, summary? })` for `routes`/`agents`/`handoffs` (merged by target id, presented as **semantic descriptions**). A keep turn pays **zero** routing cost. A concurrent model-reasoned **`hostControlGuard`** runs alongside the speaking generation as the correctness/no-leak companion (catches forgot-to-route; never blocks first generation by default).
- **Pure dispatcher** → it has no speaking turn to fold control into, so it runs a **silent internal model classifier** and dispatches. This is the derived replacement for "structured triage" — *not* a public mode. Its schema forces `transfer`/`enterFlow` and does not expose `keep`. It must never emit fallback prose.

### C. Strictness derives from driver capability, not channel name
"No user-facing dispatch text" is required where the channel can't take prose back. This derives from the **driver's output capability**, not a bare `voice` label (a native-realtime `VoiceDriver` may have already played provider audio — ADR-0004 — which cannot be un-spoken):

- **Kuralle-controlled text / cascaded voice** → relaxed default: stream; if control wins after text started, emit `text-cancel` and persist no canceled text. One narrow override `routing.dispatch?: 'strict'` (buffer until the guard/control decision is known) for compliance text.
- **Production voice where Kuralle controls TTS** → strict default: buffer outgoing text/audio to TTS until the guard returns; flush on `keep`, abort + dispatch silently on control.
- **Native realtime speech-to-speech** → strict cannot be implemented by cancelling transcript events after provider audio starts. Either suppress provider audio until guard resolution, **or** run the internal classifier before `requestResponse()`. If neither is available, the runtime **must not claim** no-dispatch-text for that turn (honest, consistent with the ADR-0004 post-hoc gate).

### D. Host-control ordering invariant
Every host control (`enterFlow`, `handoff`, `transfer_to_agent`, `end`, `escalate`, `recover`) is handled **before** any same-turn assistant text is persisted or finalized. (Today `enterFlow` is handled before persistence but `handoff` after — inconsistent.)

### D′. Guard policy (override discipline + cost)
The `hostControlGuard` is a **forgot-to-route net, not a second-guesser**: it overrides the speaking turn **only when the model produced no substantive answer** (and no control tool of its own). A real answer is authoritative — the model chose `keep` by answering, and a disagreeing guard must not hijack it (an early build let the guard route correct Q&A answers into flows; see the regression tests). The main model's own valid control tool always wins; the guard applies only to no-answer turns.
- **Cost / when it runs:** for an answering agent with host targets, the guard runs **concurrently** with the speaking turn every turn (a single control-model `generateObject`). It is hidden behind answer TTFT (no latency-coherence cost) but is a real extra call — point `routing.model` at a fast control model. Disabling it per-agent is a future knob.
- **Known limitation (tracked):** the "substantive answer" predicate is currently `trim().length > 0`. A model that emits only a short filler/ack ("Sure.") and *should* have routed is not caught. This is accepted as the lesser evil vs. hijacking correct answers, and is mitigated because the answering model holds the `enter_flow`/`transfer_to_agent` tools directly. A **model-reasoned answer-adequacy verdict** (filler vs. real answer, no lexical rules) is the planned refinement.

### D″. Strict dispatch flushes on keep
Strict dispatch buffers tokens until the model's answer intent is observable — the first substantive token (the model is answering), source end (no answer), or the model's own control tool — and only then awaits the guard. A guard route is honored only when the model did not answer (answer-authoritative). On `keep` it flushes the buffered tokens and streams the remainder live, so strict (controlled-TTS / compliance-text) TTFT ≈ first-token / guard latency, not full-generation. Any host control (tool or guard) suppresses emission entirely.

### E. Delete the mode/lexical surface (breaking)
- **Delete** `routing.mode`, `routing.always`, `routing.default` from public config.
- **Delete** `deterministicRouteMatch` + `keywordRouteFallback` and all lexical/deterministic/keyword/embedding-prototype routing from the hot path.
- **Keep** `routing.model` (chooses the control-reasoning model — not a behavior mode).
- **Add**, only as the single compliance escape hatch, `routing.dispatch?: 'strict'`.
- `select.ts` survives only as **internal model-only machinery** powering the pure-dispatcher classifier and the guard. The dead `HandoffCapability` / `TriageCapability` classes are deleted-and-replaced by a runtime-owned host-control-tool builder.

## Consequences

- **Keep-turn latency:** answering agents stop paying the upfront `generateObject`; keep turns return to base reasoner TTFT (~3× faster in the smoke). The guard's cost is hidden behind answer TTFT in the common case; strict voice pays at most the guard's TTFT (use a fast control model).
- **Breaking for consumers:** `routing.mode` / `routing.always` / `routing.default` stop typechecking. Routes-only / agents-only configs stop speaking fallback prose and become silent pure dispatchers. Fallback is now modeled as a normal semantic child agent/route (e.g. a "general support" target), not a config default; a pure dispatcher with no viable target is an invalid shape.
- **Docs:** the rule "triage must be structured when it routes" becomes "pure dispatchers route silently by derived shape; answering agents use host-control tools + guard." `apps/docs/.../guides/routing.mdx`, `CLAUDE.md`, examples, and skills update accordingly.
- **Multilingual:** routing decisions go only through model reasoning over semantic flow/route descriptions — no ASCII tokenization, no per-language prototypes.

Implementation WBS: `.handoff/wbs-routing-modes.md` (R-01…R-15), superseding `.handoff/wbs-routing-architecture.md` where they overlap.
