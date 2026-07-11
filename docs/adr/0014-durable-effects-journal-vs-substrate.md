# ADR 0014 — Durable effects: fix the portable journal, delegate *background* durability to the substrate

**Status:** Proposed (2026-07-11)
**Context owners:** Kuralle core
**Related:** teardown §2/§9.1 (F6/G8, H1, H3), gaps G8; ADR 0010 (agentic harness); the journal-scoping keystone (`runEpoch`, landed); the staged task *Intent-before-execute for durable tools (H1/H2)*. Cross-ref `feedback_cloudflare_first_class`.

## Context

Kuralle advertises "durable tool execution." The mechanism is an **application-level effect journal**: `ctx.tool(...)` → `replayOrExecute(key, execute)` hashes an effect key `sha256(logicalRunId, callsite, name, args)`, looks it up in a per-run step log, and a **hit returns the cached result without re-executing**. The log lives in the `Session` blob (`durableRuns`) and is persisted via `SessionRunStore` → the configured `SessionStore`. On Cloudflare that SessionStore is **Durable Object SQLite** (`cf-agent/src/sqlExecutor.ts` wraps `ctx.storage.sql.exec`; `KuralleAgent extends` the `agents` SDK `Agent`, using `this.sql` and `this.schedule`).

The audit found this layer is a **best-in-class idea that is not currently true**, and — more importantly — that it **conflates two different durability needs** and reinvents what the deployment substrate already provides:

1. **In-turn effect memoization.** During a single turn/logical-run, a tool must run **exactly once** even if the turn is re-entered (retry, resume, code path shift). The `runEpoch` keystone now scopes the key namespace per logical run (fixes F6/G8). What remains is **H1**: effects `execute()` *then* append the step, so a crash/eviction between the two re-runs the effect (at-least-once, not exactly-once).
2. **Cross-process concurrency (C2).** Two workers on the same session clobber each other. On CF this is a **non-issue** — a session lives in one Durable Object, which executes single-threaded (serial), so there is one writer by construction. Off-CF (Redis/Postgres, multi-instance) the stores are last-write-wins with no version column.
3. **Background durable jobs.** Scheduled wakes, engagement drips, long-running / cross-eviction orchestrations, and human-in-the-loop that spans hours are a *different* problem from an in-turn tool call.

The Cloudflare substrate (verified against `cloudflare/agents`): **Durable Objects** give transactional SQLite storage, single-threaded isolation, and durable alarms. The Agents SDK adds `runFiber()` (register in-flight work in SQLite + `keepAlive` + `onFiberRecovered` recovery + `ctx.stash()` checkpoints) and **Cloudflare Workflows** (`runWorkflow()` / `step.do()` — automatic retries, **memoized step results**, state across failures = the Temporal-equivalent durable-step primitive). Kuralle uses **none** of `runFiber`/`step.do` today; its durability is the DO-SQLite-persisted journal + DO alarms only.

## Decision

**Separate the two concerns the audit conflated, and solve each with the right tool. Do NOT replace the journal with Temporal/Workflows for synchronous in-turn tool calls.**

### 1. In-turn tool durability → fix the portable journal (do not delegate)
The journal is the correct home for **per-logical-run effect memoization** — it is conversational-flow-aware (callsite ordinals, suspend/resume, flow re-entry) in a way a generic workflow engine is not, and it is the only path that works uniformly across Memory/Redis/Postgres/DO-SQLite. Fix it, don't replace it:
- **H1 — intent-before-execute.** Write a `pending` intent row (`SessionRunStore.appendStep` gains a `finalizeStep`, carefully relaxing the append-only `index === steps.length` invariant) **before** `execute()`; finalize with the result after. On replay: a `done` step replays; a `pending` step (crash mid-execute) re-executes.
- **Idempotency-key contract.** Because re-execution of a `pending` effect is unavoidable across a hard crash (every real engine has this — Temporal/Restate/DBOS all require idempotent activities), declare and honor a per-tool idempotency key so a re-run dedups at the effect boundary. This makes the guarantee **exactly-once-modulo-idempotency**, stated honestly.
- **H2 — idempotency-key inbound input** so a webhook retry does not duplicate the user message.

### 2. Concurrency (C2) → single-writer on CF, CAS off-CF
- **On CF: rely on the substrate.** One session = one Durable Object = single-threaded = one writer. Nothing to build. Document it.
- **Off-CF:** add a monotonic `version` column and make every store write a conditional `UPDATE … WHERE version = :expected` (OCC/CAS), turning last-write-wins into stale-writer-rejected. (This is the staged C2 task; DBOS `SELECT … FOR UPDATE SKIP LOCKED` blueprint.)

### 3. Background durable jobs → delegate to the substrate (this is where `step.do()` belongs)
Introduce a **separate** `DurableJob` seam (`runDurableJob(kind, payload)`), distinct from `ctx.tool`, for long-running/multi-step/cross-eviction work (wakes, drips, HITL-over-hours, batch orchestrations). Provide substrate adapters:
- **CF:** delegate to **Cloudflare Workflows `step.do()`** (automatic retry + memoized steps) and/or `runFiber` for stream recovery — first-class per `feedback_cloudflare_first_class`.
- **Node:** a Temporal/Restate adapter, or the existing durable-scheduler + store as the portable fallback.

This is the correct use of `step.do()` — Kuralle should **not** wrap a synchronous in-turn tool call in a Workflow (latency, an extra DO/Workflow hop, and platform lock-in for something the journal already handles), but it **should** use Workflows for genuinely durable background jobs it currently backs with a bare `setTimeout` (teardown §7 — "scheduled wakes are silently lost on restart unless a durable adapter is injected").

### Non-goals / rejected alternatives
- **Delegate *all* tool calls to Temporal/CF Workflows.** Rejected: loses portability (must work off-CF), wrong tool for synchronous in-turn memoization, adds latency, and creates platform lock-in for the core primitive. The OpenAI Agents SDK delegates to Temporal because it has **no** durability of its own; Kuralle's flow-aware journal is a genuine asset — fix it, don't discard it.
- **Leave the journal as-is.** Rejected: H1 is a real correctness gap for money-moving agents (double-charge on eviction).

## Consequences

- **The guarantee becomes statable and true:** *exactly-once-modulo-idempotency, single-writer (DO / one-session-per-DO) or CAS store.* The README stops overclaiming.
- **H1 becomes a bounded, verifiable change** — with a crash-between-execute-and-append harness as its red test (the reason it was staged, not false-closed). No platform lock-in.
- **CF gets correct in-turn durability for free** (DO single-threaded + SQLite + intent-before-execute); Workflows is reserved for background jobs where it actually fits, closing the teardown §7 "wakes lost on restart" gap first-class.
- **The C2 fix is CF-trivial and off-CF-bounded** (CAS), not a universal distributed-lock project.

## Implementation order
1. **H1** (intent-before-execute + idempotency key + crash harness) — the staged task; unblocked by the `runEpoch` keystone.
2. **C2** (CAS off-CF; document single-writer on CF) — the staged task.
3. **`DurableJob` seam + CF Workflows adapter** — new task; migrate the scheduler/wake path (teardown §7) onto it.
4. **Docs** — state the guarantee; a deployment matrix (CF single-writer vs external-store-needs-CAS).
