# ADR 0010 — Agentic harness completion: escalation, wake, memory lifecycle, guardrails, simulation

Status: accepted (0.8.5)

## Context

A gap analysis against the 2026 conversational-agent baseline (Sierra/Decagon/
Parloa-class platforms) found Kuralle to be a strong *reactive turn executor*
with five missing harness capabilities — all of which had dormant seams in the
codebase (the v2 recon's "silent unwired capabilities"):

1. Escalation dead-ended: `escalate()` → `handoff('human')` → pause, with no
   handler, no handoff package, no resume path.
2. No agent-initiated turns: engagement had a dev scheduler, but the runtime
   had no proactive entry point (cart abandonment, follow-ups impossible).
3. History grew unbounded (budget truncation only); the context-overflow
   classifier (`contextOverflow.ts`) had zero callers; long-term memory had a
   preload/ingest seam but no fact extraction.
4. The guardrail pipeline (input/output processors, validation) was fully
   wired but shipped **no real guard implementations** —
   `GuardrailCapability.filterInput/filterOutput` were passthrough stubs.
5. Evaluation was scripted-turn assertions only — no simulated users, no
   LLM judge.

## Decisions

### Escalation loop (`HarnessConfig.escalation`)

All escalation paths (validator `escalate` decision, host control, handoff
tool to a terminal target, flow `escalate()` transition) converge on one
dispatcher that builds an `EscalationRequest` — state snapshot, recent
messages, optional LLM handoff brief — and invokes a host `EscalationHandler`.
Outcome is recorded on `session.metadata.lastEscalation` and emitted as an
`escalation` stream part. Flow escalations (which park on the durable
`__escalate` signal) notify at pause time; a one-shot latch
(`state.__escalationNotified`) prevents double-notification after resume.
`runtime.resumeFromEscalation(sessionId, { resolutionSummary })` hands the
conversation back: appends a system resolution note, clears parked
flow/signal state, marks the run runnable. The channel side lives in
engagement: `createOwnershipEscalationHandler` claims thread ownership (so
`ownershipGate` suppresses bot sends) and `resolveEscalation` releases +
resumes.

### Proactive wake turns + one Scheduler contract

`RunOptions.wake: { reason, payload? }` (mutually exclusive with `input`)
appends a system wake note and runs the normal loop: free-conversation agents
proactively re-engage; an active flow re-prompts its current step. A `wake`
stream part marks the turn. The `Scheduler` contract moved from engagement to
core (engagement re-exports; `SendJob` = `ScheduledJob`) so drips, broadcasts,
and wake turns share backends. `createWakeJobRunner(runtime, { deliver })`
turns wake jobs into turns and hands the produced parts to the host's
delivery function (e.g. the window-safe messaging outbound pipeline).
`createScheduleFollowupTool` lets the agent schedule its own follow-ups.
Cloudflare backend: `KuralleAgent.wakeScheduler()` / `scheduleWake()` ride
the agents SDK's DO-alarm scheduling (workerd parity test included) —
CF-first-class, day one.

### Memory lifecycle

- **Compaction** (`HarnessConfig.compaction`): post-turn (off the latency
  path), when estimated history tokens exceed `triggerTokens`, older messages
  are summarized into one leading system note; the kept tail always starts at
  a user message so tool-call pairs never split. Emits `context-compacted` /
  `compaction-skipped`.
- **Overflow recovery**: the dormant `isContextOverflowError` classifier is
  now wired — on a provider overflow the runtime strips the failed turn's
  partial messages (user message preserved), force-compacts once, retries
  once, and emits `context-overflow-recovered`.
- **Fact memory** (`createFactMemoryService({ store, model })`): LLM merge at
  ingest (existing facts + transcript → complete updated fact list) stored as
  a per-user block (`scope user`, owner = `userId`) on any
  `PersistentMemoryStore` backend — file, Postgres/Redis, or CF DO SQLite.
  Facts are injection-scanned before write. Identity was already end-to-end:
  messaging resolves `customerId` → `RunOptions.userId` → memory owner.

### Real guardrails

Shipped implementations for the existing pipeline (no new config surface):
`createPromptInjectionGuard` (reuses the audited memory-write pattern set),
`createPiiInputGuard`/`createPiiOutputGuard` (Luhn-validated cards, emails;
opt-in phone/IBAN; redact-or-block), `createModerationGuard` (temperature-0
LLM classifier, fail-open default), and `createGroundingValidator` (the
productized Kapruka H6 gate: completed-action claims checked against tool
calls/state/citations, rewrite-not-block). Pre-turn blocks now emit
`safety-blocked` with the moderator id.

### Simulated-user eval + LLM judge

`simulateConversation` drives an LLM persona (profile, goal, temperament)
against a real runtime until goal-met/give-up/max-turns; `createJudge` scores
the transcript on a rubric (goal completion, grounding, tone, efficiency —
1–5 with rationales); `runSimulationSuite` is the CI gate (a gave-up
conversation always fails). Complements `EvalRunner`: scripted turns test the
happy path you thought of; simulated users find the conversations you didn't.

## Consequences

- All additions are additive; no breaking API changes (see MIGRATION).
- New stream parts: `escalation`, `wake`, `safety-blocked` (now emitted
  pre-turn), `context-compacted`, `compaction-skipped`,
  `context-overflow-recovered`.
- The in-memory escalation/wake/order primitives default to single-process;
  production deployments supply durable backends (DO alarms ship; queue
  adapters are interface-compatible).
