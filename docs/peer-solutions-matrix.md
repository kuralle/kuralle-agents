# How the ecosystem solves Kuralle's 13 confirmed findings

**Date:** 2026-07-11 · **Status:** Ready for review
**Companion to:** [`docs/claim-verification-results.md`](./claim-verification-results.md) (the 19/19 CONFIRMED verification),
the durability audit, [`docs/agentic-voice-framework-gaps.md`](./agentic-voice-framework-gaps.md).
**Question answered:** for each of the **13 structural findings** that verification CONFIRMED, how do the leading
agentic frameworks, coding agents, and durable-execution harnesses solve the same underlying problem — and what
should Kuralle steal?

## Method & grounding

- **Discovery via `gh` CLI.** The candidate set was confirmed with `gh repo view`/`gh search` (stars below), not memory.
- **Per-finding research** was done by grounded agents using the `gh` CLI (code/file reads) + DeepWiki (repo-grounded Q&A). Every cell cites `repo:path` or `deepwiki:<repo>`.
- **Two honesty caveats, preserved from the research:**
  1. **Rasa CALM is closed-source (Rasa Pro).** The official `RasaHQ/rasa` repo is Rasa *Open Source* and does **not** contain CALM (`DialogueStack`, `pattern_correction`) — confirmed by zero `gh`/DeepWiki hits in `org:RasaHQ`. CALM evidence below is grounded in **`ehzawad/rasa-code`**, a public third-party repo that is file-for-file the genuine Rasa Pro `dialogue_understanding` module (terminology + layout match; vocabulary cross-checked against `RasaHQ/rasa-calm-hybrid-demo`). It is the closest `gh`-referenceable grounding for closed-source Rasa Pro — cited as such, not as an official repo.
  2. **`gh search code` hit GitHub's rate limit** mid-research for the agent-SDK cluster after `openai/openai-agents-python`; the other four SDKs there rest on DeepWiki's (code-cited) answers, not independent `gh` re-verification. `openai-agents-js` parallel-tools (G9) is explicitly flagged uncertain.

## The landscape (gh-confirmed, star-ranked)

| Category | Repos (stars, 2026-07) |
|---|---|
| Coding agents / harnesses | `openai/codex` 97k · `OpenHands/OpenHands` 80k · `cline/cline` 64k · `aaif-goose/goose` 51k · `Aider-AI/aider` 47k · `SWE-agent/SWE-agent` 20k |
| Agent frameworks | `microsoft/autogen` 60k · `crewAIInc/crewAI` 55k · `langchain-ai/langgraph` 37k · `microsoft/semantic-kernel` 28k · `openai/openai-agents-python` 28k · `mastra-ai/mastra` 26k · `vercel/ai` 25k · `letta-ai/letta` 24k · `google/adk-python` 20k · `openai/openai-agents-js` 3k |
| Conversational / voice | `RasaHQ/rasa` 21k (CALM = Rasa Pro, closed) · `emcie-co/parlant` 18k · `pipecat-ai/pipecat` 13k · `livekit/agents` 11k · `pipecat-ai/pipecat-flows` 0.6k |
| Durable execution | `temporalio/temporal` 22k · `inngest/inngest` 6k · `restatedev/restate` 4k · `dbos-inc/dbos-transact-py` 1.5k |

---

## A. Durability spine — H1, H3, C2

### H1 — Exactly-once side effects (Kuralle executes *then* records → double-fire on crash)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Restate** | ✅ | Journal entry written to RocksDB **before** the effect runs; replay `is_resumable()` skips completed entries (`restatedev/restate:crates/worker/src/partition/state_machine/mod.rs`). |
| Temporal | ✅ | History events persisted atomically before the activity dispatches; `start_request_id` makes task-started idempotent. |
| Inngest | ✅ | `step.run` output saved with idempotent-write dedup (`ErrIdempotentResponse`) — record is post-exec but dedup closes the gap. |
| DBOS Transact | ⚠️ | **Execute-then-record** — the *same bug class as Kuralle*; upsert to `operation_outputs`, mitigated only by convention that steps are idempotent. |
| LangGraph | ⚠️ | Pending-writes replay is a *state-application* guarantee, not a pre-execution intent log; a real API call mid-node isn't journaled first. |
| OpenAI Agents SDK | ✅ (delegated) | No native mechanism — wraps `RunState` in a Temporal workflow and inherits Temporal's guarantees. |

**Best-in-class: Restate.** **Adopt →** [issue: *Scope the durable journal* — H1 part]: write an intent row (tool+args+idempotency key) committed **before** invoking the tool; check the journal for a completed/dedup match before ever calling the tool body again. *(Note: DBOS ships the identical execute-then-record bug — this is a well-known trap, not a Kuralle idiosyncrasy.)*

### H3 — Log retention/pruning (Kuralle's step journal grows forever in the session blob)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Temporal** | ✅ | `continue-as-new` truncates history into a fresh run carrying only needed state; hard 50MB/50k-event ceiling forces it (warns via `SuggestContinueAsNew`). |
| Restate | ✅ | Configurable `journal_retention` + background `Cleaner` purge; `restart-as-new` carries only a journal prefix. |
| Inngest | ✅ | Hard caps (1k steps / 32MB) fail the run rather than grow unbounded — a ceiling, not compaction. |
| DBOS / LangGraph | ⚠️ | Only *manual* GC / `prune()` — never auto-runs; LangGraph is unbounded append-only by default. |

**Best-in-class: Temporal.** **Adopt →** [issue: *Scope the durable journal* — H3 part]: a first-class continue-as-new op (fold needed state into a fresh minimal state, drop the rest) **plus a hard size/step ceiling that forces the fold** — don't rely on an operator calling prune.

### C2 — Cross-process concurrency (Kuralle: in-process mutex only; stores are last-write-wins)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Restate** | ✅ | Single-writer-per-partition-key with a `LeaderEpoch` monotonic **fencing token**; stale-epoch writes discarded. |
| **DBOS** | ✅ | `SELECT … FOR UPDATE SKIP LOCKED` on Postgres — the most directly portable to a Postgres session store. |
| Temporal | ✅ | Shard ownership + execution lease + task-token binding rejects stale completions. |
| Inngest | ✅ | Redis atomic Lua leasing with TTL + `SET NX` idempotency. |
| LangGraph | ⚠️ | **PostgresSaver has NO OCC — plain UPSERT, last-write-wins — structurally identical to Kuralle's C2 bug.** |

**Best-in-class: Restate (fencing) / DBOS (portable).** **Adopt →** [issue: *Add versioned CAS to session stores (C2)*]: a monotonic `version` column; every write is `UPDATE … WHERE version = :expected` — turns "last-write-wins" into "stale-writer-rejected", no new infra. *(LangGraph's Postgres checkpointer has the same unfixed bug — this is not hypothetical.)*

---

## B. Handoff & orchestration — G16, G12, G4

### G16 — Full agent-surface rebuild on handoff (Kuralle keeps the *source's* persona/policies/executor → chimera)
| Framework | Solves? | Mechanism |
|---|---|---|
| **OpenAI Agents SDK (py+js)** | ✅ | Handoff target is a first-class `Agent` value; the Runner does one **atomic swap** of the current agent to it (its own instructions/tools/guardrails/model). |
| AutoGen | ✅ | Each `AssistantAgent` owns its context/system-messages/model-client; a `HandoffMessage` only injects extra context into the *receiver's own* state. |
| CrewAI | ✅ | Delegation hands the task to a fully separate `Agent` (own role/goal/backstory/LLM/tools). |
| Google ADK | ⚠️ | Self-contained agents, but a sub-agent may *intentionally* inherit the coordinator's `model` if unset. |

**Best-in-class: OpenAI Agents SDK.** **Adopt →** [issue: *Rebuild the full agent surface on handoff (G16)*]: model the target as a complete `Agent` value and **atomically replace the entire active-agent reference** (persona, model, tools, policies, executor) — never carry sender fields piecemeal.

### G12 — Handoff input filtering (Kuralle exported the *types* for this but wired zero call sites)
| Framework | Solves? | Mechanism |
|---|---|---|
| **OpenAI Agents SDK (py+js)** | ✅ | `Handoff.input_filter: (HandoffInputData) → HandoffInputData` + global default + per-handoff override + `nest_handoff_history` + a shipped `handoff_filters` helper library (strip tool calls, keep last N). |
| AutoGen | ⚠️ | `HandoffMessage.context` — hand-rolled per call site; no built-in strip/summarize/last-N. |
| Google ADK | ⚠️ | `include_contents` binary (all/none) + overflow compaction — general, not handoff-scoped. |
| CrewAI | ❌ | Free-text `context` string only. |

**Best-in-class: OpenAI Agents SDK — this is the exact API Kuralle copied the types of.** **Adopt →** [issue: *Wire or delete handoffFilters.inputFilter (G12)*]: wire a `HandoffInputData`-shaped boundary object + pluggable filter hook, default pass-through, per-handoff override — and preserve the model-authored handoff summary.

### G4 — Handoff loop bounds (Kuralle: `handoffCount` resets each turn; `handoffHistory` written but never read)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Google ADK** | ✅ | `max_llm_calls` counts the **whole invocation** (never resets) + structural transfer guards (reject self-transfer, `disallow_transfer_to_parent`/`_to_peers`). |
| AutoGen | ⚠️ | Run-scoped `MaxMessageTermination` + `HandoffTermination(target)` to break a specific cycle; compose AND/OR. |
| OpenAI Agents SDK | ⚠️ | `max_turns` (default 10) whole-run counter, but no cycle detection. |
| CrewAI | ⚠️ | `max_iter` per-agent, weakest. |

**Best-in-class: ADK** (none do true history-based oscillation detection). **Adopt →** [issue: *Suppress cross-turn handoff ping-pong (G4)*]: make the counter run-scoped (never reset per turn) **and read the already-recorded `handoffHistory`** to reject an immediate back-transfer to the agent just left — the cheapest fix since the data already exists.

---

## C. Parallel tool execution — G9

| Source | Solves? | Mechanism |
|---|---|---|
| **AutoGen** | ✅ | `asyncio.gather` concurrent **by default**; opt out per client with `parallel_tool_calls=False` for side-effecting tools. |
| **Codex** | ✅ | Parallelism is a **property of the tool**: read-only/`read_only_hint` tools take a read lock (parallel); mutating tools take a write lock (serial), decided by the `ToolRouter`. |
| OpenAI Agents SDK (py) | ✅ | Concurrent function-tool execution with a `max_function_tool_concurrency` cap. |
| OpenHands | ⚠️ | `tool_concurrency_limit` (default 1 = serial), configurable. |
| Google ADK | ⚠️ | Tool *resolution* concurrent, *invocation* deliberately serial (later tools depend on earlier state). |
| CrewAI / Aider | ❌ | Task-level only / strictly serial. |

**Best-in-class: Codex + AutoGen (same idea).** **Adopt →** [issue: *Add parallel tool execution after journal scoping (G9)*]: classify tools **parallel-safe vs exclusive** (read-only → concurrent, mutating/`needsApproval` → exclusive lock) and `Promise.all` the safe batch — inverting today's serial-by-default / opt-in-parallel posture. Must land **after** the journal-scoping keystone (concurrency needs the deterministic-ordinal journal).

---

## D. Flow, determinism & correction — G1, G14, G2 (Rasa CALM dominates)

### G1 — Digression / topic stack (Kuralle parks ONE flow in a single slot; a 2nd pivot overwrites it)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Rasa CALM** | ✅ | `DialogueStack` = **list of frames**; a digression pushes a `UserFlowStackFrame` with `frame_type=INTERRUPT`; completion pops back — arbitrary depth, N nested interrupts resume in reverse (`ehzawad/rasa-code:dialogue_understanding/stack/`). |
| Parlant | ⚠️ | Backtrack/fast-forward within one journey's path — not a stack of independently-parked other journeys. |
| pipecat-flows | ❌ | Single scalar `_current_node` — same single-slot limitation as Kuralle. |

**Best-in-class: Rasa CALM.** **Adopt →** [issue: *Replace __flowPark single slot with a park stack (G1)*]: a list-of-frames `DialogueStack` with a typed `frame_type` — push on digress, pop on completion, arbitrary depth for free. This is a **direct blueprint** for the G1 fix.

### G14 — Slot correction (Kuralle: slots write-once; confirm-decline discards the correction)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Rasa CALM** | ✅ | `CorrectSlotsCommand` diffs only changed slots → `CorrectionPatternFlowStackFrame` pushed → `SlotSet` overwrites mid-flow; `ask_before_filling` distinguishes overwrite vs reset-to-ask; nested corrections sequence correctly. |
| Parlant | ⚠️ | Detects a changed prior decision, backtracks + re-executes — folded into general backtracking, no named correction primitive. |
| pipecat-flows | ❌ | Free-form dict; overwrite only if the author hand-codes it — confirms Kuralle's bug pattern. |

**Best-in-class: Rasa CALM `pattern_correction`.** **Adopt →** [issue: *Reset collect slot + extract over confirm-decline (G14)*]: a dedicated "correct slot" command that (a) diffs vs the current value, (b) distinguishes overwrite vs reset-to-ask, (c) is itself a stack frame so a correction-of-a-correction sequences instead of clobbering.

### G2 — Deterministic control as the DEFAULT (Kuralle: opt-in behind an experimental flag, default off)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Rasa CALM** | ✅ | The LLM's raw text is fed through a **regex whitelist** (`command_parser.parse_commands` against a closed `DEFAULT_COMMANDS` set); anything not matching a known command grammar produces no command and **cannot mutate the stack**. Baseline architecture, not a flag. |
| pipecat-flows | ⚠️ | Default-constrains *transitions* to the node's declared functions, but the text channel still free-converses (narrower than Rasa). |
| Parlant | ⚠️ | Deterministic-ish by default; hard determinism (canned templates) needs opt-in `CompositionMode.STRICT`. |

**Best-in-class: Rasa CALM.** **Adopt →** [issue: *Flip determinism defaults (F5/G2)*]: put determinism **in the parser, not a prompt or an opt-in flag** — discard any LLM completion that doesn't match a fixed, closed command grammar, so no code path lets an unconstrained utterance reach flow state. This is the philosophical inverse of Kuralle's default-off `outOfBandControl`.

---

## E. Context & memory — G6, G5, F1

### G6 — Session retrieval cache (Kuralle defined `retrievalCache` then never wired it)
| Framework | Solves? | Mechanism |
|---|---|---|
| **LangGraph** | ✅ | `BaseStore` — namespaced KV store (`("docs","user123")`) with TTL + optional vector `search()`, **decoupled from checkpointed history**, injected into tools via `InjectedStore()` (`langchain-ai/langgraph:libs/checkpoint/.../store/base/__init__.py`). |
| Mastra | ✅ | `WorkingMemory` (schema/Markdown, per-thread/resource) + `ObservationalMemory` compression. |
| Letta | ✅ | Core-memory `Block`s in-prompt + archival `Passage` embeddings (`archival_memory_search`). |
| LiveKit / Vercel AI | ❌ | Out of scope — no session store primitive. |

**Best-in-class: LangGraph `BaseStore`.** **Adopt →** [issue: *Wire the session retrieval cache (G6)*]: wire the dead `retrievalCache` to exactly this shape — namespaced by session, queryable **independent of compaction**, not just another chat message.

### G5 — Goal/thread tracking (Kuralle has no goal field — delegated to the LLM re-reading history)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Letta** | ✅ | Core-memory `Block` (label+value+description), self-edited via a memory tool, always in-context, distinct from history. |
| **Mastra** | ✅ | `WorkingMemory` schema — structured persistent goals/preferences re-injected each turn. |
| **Codex / OpenHands / goose** | ✅ | Structured plan/todo objects (`update_plan`→`TodoItem`, `PLAN.md`+`TaskTrackingAction`, goose Plan/Recipe/Todo) kept **outside** the raw message log. |
| LangGraph | ⚠️ | Typed `State` can carry a `plan` field — a pattern it enables, no default schema. |

**Best-in-class: Letta core-memory `Block` / goose's Plan+Todo separation.** **Adopt →** [issue: *Add structured goal/thread tracking (G5)*]: a structured `goal`/`openTopics` field mutated only via an explicit tool/reducer (not free-text reinterpretation), always projected back into context.

### F1 — Real token accounting (Kuralle estimates chars/4; its real-usage accumulator is unwired)
| Framework | Solves? | Mechanism |
|---|---|---|
| **Vercel AI SDK** | ✅ | `LanguageModelUsage` from real provider fields + `addLanguageModelUsage` associative accumulator folding per-step into a run total (`vercel/ai:packages/ai/src/types/usage.ts`). **Kuralle is built on this SDK — `result.usage` is already available, just unwired.** |
| **goose** | ✅ | Real usage-ratio trigger: compaction at `GOOSE_AUTO_COMPACT_THRESHOLD` (0.8 of provider context limit) + separate tool-output summarization at a call-count cutoff. |
| LiveKit | ✅ | `ModelUsageCollector` aggregates real per-provider usage across a session. |
| Letta | ✅ | `ContextWindowOverview` — full real breakdown for window management. |
| Codex / Aider | ✅ | Real `usage` → auto-compact at a token limit. |
| LangGraph | ❌ | `usage_metadata` pass-through only, no accumulator/budgeting. |

**Best-in-class: Vercel AI SDK (Kuralle already depends on it) + goose's usage-ratio trigger.** **Adopt →** [issue: *Wire TokenAccumulator + real-usage compaction trigger (F1)*]: feed `result.usage` (already there) into the dead accumulator; trigger compaction on a real usage-ratio against the provider context limit; prune tool outputs as a separate lever from message compaction.

---

## Cross-cutting takeaways

1. **Kuralle is not alone in its bugs — but it's behind on the fixes.** LangGraph's Postgres checkpointer has the *same* C2 last-write-wins defect; DBOS has the *same* H1 execute-then-record defect. These are industry-wide traps — but Restate/Temporal/DBOS(-CAS)/Codex show the solved shape.
2. **Three findings have a single dominant blueprint to copy wholesale:** Rasa CALM's `DialogueStack` (G1), `pattern_correction` (G14), and command-parser-as-gate (G2). Kuralle's flow layer should adopt the stack-of-frames model directly.
3. **The cheapest wins are already-present-but-unwired.** F1 (Vercel AI SDK `result.usage`), G12 (the `HandoffInputData` types Kuralle copied from the OpenAI Agents SDK), and G4 (the `handoffHistory` already written) need *wiring*, not new subsystems — mirroring the verification's own "wiring/scoping, not missing subsystems" conclusion.
4. **Determinism default is the philosophical gap.** Every strong dialogue framework (Rasa CALM especially) makes structural control the *default* and puts it in the *parser*; Kuralle's `outOfBandControl` is opt-in and experimental. This is the single biggest posture difference.
5. **Coding harnesses (Codex/goose/OpenHands) validate the durable-store direction** Kuralle's own roadmap points at: a queryable session store with tool results as first-class rows, keyed independently from the replay journal (goose's SQLite), plus structured plan/memory stores separate from the message log.

## Evidence

Per-cluster grounded reports (with all `repo:path` / `deepwiki:` citations) are the source of this synthesis; the durability, agent-SDK, dialogue, memory, and coding-harness clusters were each researched independently via `gh` + DeepWiki. Findings map 1:1 to the fix issues on the Plan Desk board (project *aria-flow*) and to [`docs/claim-verification-results.md`](./claim-verification-results.md).
