# Harness Engineering — Plan: kuralle-core as the reusable conversational harness

## Thesis

"Harness = everything around the model" (mindstudio:8-11); the model is rarely the bottleneck — the scaffolding is what differentiates outcomes (same model, Opus 4.5 scored 95% under Claude Code vs 42% under a small agent — reader [KijChx7q2nY]). kuralle-core is *already* a harness: it owns the agent loop, routing (flows), tools (durable `defineTool`), sessions/memory, hooks, validation and grounding — the exact taxonomy the sources prescribe. The gap between kuralle and a product harness like Claude Code / Hermes-on-Pi is **not the loop**; it is three missing leaf primitives that the sources rank highest-leverage: (1) **skills** — JIT-loaded procedure (name+description+body) that products use to externalize SOPs without bloating the prompt; (2) a **first-class workspace / filesystem-as-memory** field (kuralle *has* `FilePersistentMemoryStore` + `buildMemoryBlockTool` but they are exported leaves, not wired into `AgentConfig`/Runtime); (3) an **explicit error-recovery budget** around tool execution (kuralle has context-overflow recovery and a durable effect-log, but no general descriptive-error + retry-budget loop). The argument of this doc: keep kuralle-core as the loop, add these as **minimal, mostly-already-built** primitives — do not invent a new agent framework.

### TL;DR proposed changes

- **New package `@kuralle-agents/skills`** — `defineSkill({ id, description, when?, body, tools? })` + `loadSkillsTool` (a single `defineTool` that lists name+description and loads `body` on demand). JIT loading = only name+description in context until invoked (the "map not manual" principle, openai:43-56; YAML-frontmatter JIT, reader [d33CK8uuji0]).
- **Promote the existing memory-blocks primitive to first-class config** — add `AgentConfig.workspace?: WorkspaceConfig` (wraps the already-built `PersistentMemoryStore`/`buildMemoryBlockTool`, `memory/blocks/`), so file-backed working memory (USER.md/MEMORY.md/scratchpad) auto-loads + exposes the edit tool. Today it is exported from `index.ts:125-133` but **never consumed by Runtime**.
- **Add `AgentConfig.skills?: Skill[]`** — derive a `loadSkillsTool` into the speaking turn (same mechanism as `globalTools`, agentConfig.ts:33).
- **Add a recovery budget to `defineTool` execution** — `RecoveryPolicy { maxRetries, reformulateOnError, onExhausted: 'escalate'|'fail' }` on `HarnessConfig`/`AgentConfig`, layered on the existing `CoreToolExecutor` + `recoverFromContextOverflow` (contextOverflow.ts:157). Descriptive errors back to the model ("what happened + how to fix"), capped loop, escalate on exhaustion (readers [K4-flzsPraE], [d33CK8uuji0]).
- **No new agent loop, no multi-agent dispatcher, no `platform` field.** Single consolidated brain is the sources' keystone (reader [K4-flzsPraE], [KijChx7q2nY]); kuralle already has it.

---

## 1. Harness component taxonomy → kuralle-core layer

| Harness component | Source | kuralle has it? | Where (file:line) |
|---|---|---|---|
| System prompt / role + "what NOT to do" | mindstudio:13,22 | Yes | `prompts/AgentPrompt.ts`, `PromptAssembly.ts`; `AgentConfig.instructions` agentConfig.ts:20 |
| Context management (what passes, summarize/drop, hierarchy) | mindstudio:14,23 | Partial | `runtime/ContextBudget.ts`, `contextOverflow.ts:94` (overflow classify+recover); compaction is recovery-only, not proactive |
| Memory — short-term (in-context) | mindstudio:15 | Yes | `RunState.messages` durable/types.ts:34; session.messages openRun.ts:96 |
| Memory — long-term (retrieved from DB) | mindstudio:15 | Yes | `memory/MemoryService.ts`, `HarnessConfig.memoryService` Runtime.ts:53; gather memoryBlock gather.ts:38 |
| Memory — working-state / filesystem (write plan to file) | reader [KijChx7q2nY],[7fbY8k9Mz3M],[Khfiy1lwGPs] | **Built, not wired** | `memory/blocks/FilePersistentMemoryStore.ts`, `buildMemoryBlockTool` memoryBlockTool.ts:86 — exported index.ts:125-133, **never consumed by Runtime** |
| Tool integrations (name/desc/schema/callback, guardrails-in-description) | mindstudio:16,24; reader [hcm5zIWASCM] | Yes (exact match) | `tools/effect/defineTool.ts:13` ({name,description,input,execute}); durable executor `ToolExecutor.ts:34` |
| Routing & orchestration ("logic in harness not model") | mindstudio:17,25 | Yes | `flows/`, `AgentConfig.routes/routing/agents` agentConfig.ts:35-37; `capabilities/TriageCapability.ts` |
| Input/output parsing (structure before/after model) | mindstudio:18 | Yes | `processors/ProcessorRunner.ts`; `extraction/`; validate via Zod `tools/effect/schema.ts` |
| Error handling & fallbacks (validate output, retry, route-to-human) | mindstudio:19,24,26; reader [K4-flzsPraE] | Partial | overflow retry `contextOverflow.ts:157`; durable replay/idempotency `runtime/durable/replay.ts`,`idempotency.ts`; `escalation/`; **no general retry-budget loop** |
| Skills (JIT procedure: instructions+code+refs) | reader [KijChx7q2nY],[d33CK8uuji0],[Khfiy1lwGPs] | **No** | — (closest: `globalTools` agentConfig.ts:33, but a tool ≠ a loadable SOP) |
| Hooks / lifecycle observability (before/after tool) | reader [hcm5zIWASCM] | Yes | `types/runtime.ts:72-81` (onToolCall/onToolResult/onToolError); `hooks/HookRunner.ts` |
| Traces / evals as observability | reader [K4-flzsPraE] | Yes | `eval/`, `services/TracingService.ts`, `audit/`, `foundation/ConversationEventLog.ts` |
| Validation / grounding gate (secondary check) | mindstudio:19; framework rule | Yes | `capabilities/ValidationCapability.ts`, `AgentConfig.validate` agentConfig.ts:44 |
| Checkpointing / exactly-once recovery (outer loop) | reader [K4-flzsPraE] | Yes | `runtime/durable/SessionRunStore.ts`, `StepRecord` durable/types.ts; effect-log replay `replay.ts` |
| Model-agnostic backend swap | mindstudio:30-31; [hcm5zIWASCM] | Yes | AI SDK `LanguageModel`; `AgentConfig.model`/`controlModel` agentConfig.ts:21-25 |

**Verdict:** every taxonomy row except **Skills** is present in some form. The two "Partial/built-not-wired" rows (working-state filesystem, error-recovery budget) are the prioritized gaps.

---

## 2. Deconstruction to primitives

The reducible interfaces the sources converge on, and which kuralle already implements.

### 2.1 Tool = {name, description, input-schema, callback}

Reader [hcm5zIWASCM]: "a tool needs exactly four parts: name, description, input schema, callback… the description is what the model reads to decide when to use it… constraints go in the description in plain English… structure enforced via the input schema." This is **literally** `defineTool` (defineTool.ts:13-34): `{ name?, description, input?: zod, execute }`. kuralle additionally has the durable side (`ToolExecutor.ts` effect-log → exactly-once on retry) which the sources call the "outer loop that checkpoints" (reader [K4-flzsPraE]). No change needed.

### 2.2 Skill = {id, description, when?, body, tools?} — JIT-loaded

Reader [Khfiy1lwGPs]: `skills/<name>/skill.md` loaded only when the task calls for it; **description required** or the harness refuses to use it. Reader [d33CK8uuji0]: YAML front-matter = keywords + description so only name+description load until needed (unlike MCPs that load fully). Reader [KijChx7q2nY]: Cursor replaced 15,000 lines of orchestration with a ~200-line skill — but skills can *reduce* performance if redundant, so evaluate with/without. The minimal interface: an id, a one-line description (the only thing in context until selected), an optional `when` trigger hint, the loadable body, and optional tools the body needs.

### 2.3 Workspace = filesystem-as-memory (load/save/list named docs)

Reader [7fbY8k9Mz3M]: context delivery is shifting from retrieval to **navigation** — let the model `grep/ls/cat` a sandbox. Reader [KijChx7q2nY]/[Khfiy1lwGPs]: write the plan to markdown, check off to-dos; memory is a filesystem dir. kuralle already has the exact store interface — `PersistentMemoryStore { loadBlock, saveBlock, deleteBlock, listBlocks }` (blocks/types.ts:46-66) backed by `FilePersistentMemoryStore` (USER.md/MEMORY.md, char-limited, atomic rename, FilePersistentMemoryStore.ts:35), plus the LLM-facing `buildMemoryBlockTool` (memoryBlockTool.ts:86). The primitive is **built and tested**; it is simply not a config field.

### 2.4 Recovery loop = {classify error → descriptive message → bounded retry → escalate}

Reader [K4-flzsPraE]: the single biggest quality win was teaching error recovery + an explicit **budget** + descriptive errors ("what happened and how to fix"). Reader [d33CK8uuji0]: loop until an LLM-judge passes but cap it; escalate to a human when the budget is exhausted. kuralle has *one specialization* of this — `isContextOverflowError` + `recoverFromContextOverflow` + single retry (contextOverflow.ts:94,157) — but no general tool-error budget.

### 2.5 Comparison across studied systems

| Primitive | Claude Code / Hermes (readers) | OpenAI repo-as-harness (openai) | kuralle-core today |
|---|---|---|---|
| Loop / brain | single consolidated brain [K4-flzsPraE] | depth-first building blocks, Ralph loop (openai:28-29) | single loop: `Runtime.run` Runtime.ts:88 |
| Tool def | name/desc/schema/cb [hcm5zIWASCM] | typed boundary, Zod (openai:66-74) | `defineTool` defineTool.ts:13 ✅ |
| Skill | `skills/<n>/skill.md` JIT [Khfiy1lwGPs] | docs/ system-of-record, AGENTS.md TOC (openai:43-56) | **missing** |
| Working memory | filesystem dir [Khfiy1lwGPs] | repo as system-of-record (openai:52) | `memory/blocks/*` built, unwired |
| Long-term memory | retrieved DB [mindstudio:15] | versioned docs/ (openai:60) | `MemoryService` Runtime.ts:53 ✅ |
| Context mgmt | compact/summarize [KijChx7q2nY] | minimize tokens (openai) | overflow-recovery only contextOverflow.ts ⚠️ |
| Error recovery | budget + descriptive errors [K4-flzsPraE] | invariants as error msgs (openai:74) | overflow retry only ⚠️ |
| Checkpoint | outer-loop checkpoint [K4-flzsPraE] | — | durable effect-log replay.ts ✅ |
| Hooks | before/after tool [hcm5zIWASCM] | custom-lint remediation in context (openai:74) | `onTool*` runtime.ts:72-81 ✅ |
| Traces/evals | raw trace value [K4-flzsPraE] | Ralph self-review (openai:29) | `eval/`,`TracingService` ✅ |

---

## 3. Proposed Kuralle design (minimal, copy-proven)

Three additions. Two are *wiring of already-built code*; one is a small new package modeled on a proven design.

### 3.1 Skills — new package `@kuralle-agents/skills`

Copy the **Hermes/Claude-Code skill shape** verbatim (reader [Khfiy1lwGPs]: `skill.md` with required description; reader [d33CK8uuji0]: name+description-only until invoked). Do **not** invent MCP-style full-load.

```ts
// packages/kuralle-skills/src/defineSkill.ts
export interface Skill {
  id: string;
  /** The ONLY text in context until the skill is loaded. Required — a skill
   *  with no description cannot be selected (reader [Khfiy1lwGPs]). */
  description: string;
  /** Optional trigger keywords/when-to-use hint, kept in the listing. */
  when?: string;
  /** Loadable procedure body (markdown SOP). Loaded on demand only. */
  body: string | (() => Promise<string>);
  /** Optional tools the body needs (effect tools). */
  tools?: Record<string, AnyTool>;
}
export function defineSkill(s: Skill): Skill { return s; }
```

The loader is **one `defineTool`** (defineTool.ts is the exact substrate — no new tool machinery):

```ts
// packages/kuralle-skills/src/loadSkillsTool.ts
export function buildLoadSkillsTool(skills: Skill[]) {
  return defineTool({
    name: 'load_skill',
    description:
      'Load a skill (a procedure for a task). Available skills:\n' +
      skills.map(s => `- ${s.id}: ${s.description}${s.when ? ` (use when: ${s.when})` : ''}`).join('\n'),
    input: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      const s = skills.find(x => x.id === id);
      if (!s) return { error: `No skill "${id}". Available: ${skills.map(x => x.id).join(', ')}` };
      return { body: typeof s.body === 'function' ? await s.body() : s.body };
    },
  });
}
```

Only id+description+when reach the model until `load_skill` fires — the "map not manual" / progressive-disclosure principle (openai:43-56), JIT-load not full-load (reader [d33CK8uuji0]). The descriptive-error branch (`No skill "..."`) follows reader [K4-flzsPraE].

### 3.2 AgentConfig field additions

```ts
// types/agentConfig.ts — added fields (mirrors existing globalTools comment at :28-33)
export interface AgentConfig {
  // ...existing...
  /** JIT-loadable procedures. Exposed as a single `load_skill` tool in
   *  speaking turns; only id+description load until invoked. */
  skills?: Skill[];
  /** File-backed working memory (USER.md/MEMORY.md/scratchpad). Auto-loads
   *  configured blocks into the prompt + exposes `memory_block` edit tool.
   *  Wraps the existing memory/blocks primitive. */
  workspace?: WorkspaceConfig;
}
```

`WorkspaceConfig` is `PersistentMemoryConfig` (blocks/types.ts:68-82) — **it already exists**; promote it:

```ts
export interface WorkspaceConfig {
  store?: PersistentMemoryStore;            // default FilePersistentMemoryStore
  autoLoad?: Array<{ scope: MemoryBlockScope; key: string }>; // default USER/MEMORY
  defaultCharLimit?: number;
  scanForInjection?: boolean;               // default true (safetyScanner.ts)
}
```

Wiring (the actual new work):
- In `deriveAgent.ts` / the speaking-turn tool assembly (same place `globalTools` is merged), if `agent.skills?.length` → add `buildLoadSkillsTool(skills)` to the model-visible set; register each skill's `tools` as effect executors.
- In the prompt-gather path (`runtime/grounding/gather.ts:38`, which already produces a `memoryBlock` string) — if `agent.workspace`, load `autoLoad` blocks via the store and append (the "frozen-snapshot once per session" pattern the types already describe, blocks/types.ts:15-18, but which Runtime does not yet execute). Expose `buildMemoryBlockTool` as an effect tool.

This is the smallest wiring that turns built-but-orphan code into a config field. No new abstraction.

### 3.3 Recovery budget on tool execution

Layer onto the existing `CoreToolExecutor` (ToolExecutor.ts) and reuse `recoverFromContextOverflow`:

```ts
// HarnessConfig (Runtime.ts:41) and/or AgentConfig
export interface RecoveryPolicy {
  maxRetries: number;                 // budget — cap the loop (reader [d33CK8uuji0])
  /** On tool error, return a descriptive message to the model and let it
   *  reformulate (reader [K4-flzsPraE]). Default true. */
  reformulateOnError?: boolean;
  onExhausted?: 'escalate' | 'fail';  // escalate → escalation/ HandoffCapability
}
```

The executor already produces typed errors (`ToolValidationError`, `ToolTimeoutError`, errors.ts/schema.ts). The change: on caught tool error, if budget remains, feed `{ error: <what happened + how to fix> }` back as the tool result (the descriptive-error contract) and let the model retry; on exhaustion, `onExhausted` routes to the existing `escalation/`/`HandoffCapability.ts`. Default `maxRetries: 0` preserves current behavior (surgical, opt-in).

### 3.4 Node-vs-Cloudflare portability

| Primitive | Node/Bun | Cloudflare Workers/DO |
|---|---|---|
| Skills (`defineSkill`, `load_skill` tool) | portable — pure data + one tool | **portable** — no fs needed; `body` is a string or async fn |
| Workspace store | `FilePersistentMemoryStore` (POSIX rename, FilePersistentMemoryStore.ts:21-49) | needs a DO/KV-backed `PersistentMemoryStore` impl — the interface (blocks/types.ts:46) is already storage-agnostic; cf-agent already has `OrchestrationStore` (DO SQLite) + `BridgeSessionStore` to model it on |
| Recovery budget | portable (pure control flow over executor) | portable |
| Checkpoint/effect-log | `SessionRunStore` over `SessionStore` | already works on DO (cf-agent `BridgeSessionStore`) |

Portability rule (matches readers' caveat): **the skill primitive is fully substrate-agnostic** (string bodies, no shell). The **only** runtime-specific piece is the workspace *backend* — POSIX fs on Node, a DO/KV `PersistentMemoryStore` on Workers. The interface is identical; ship a `CfMemoryStore` in `@kuralle-agents/cf-agent` mirroring `OrchestrationStore`. Do **not** import `node:fs` into core; the default `FilePersistentMemoryStore` already lives behind the `PersistentMemoryStore` interface (blocks/types.ts:46), so core stays portable and the fs default is selected only when no `store` is provided. Reject CLI-over-MCP / Python-REPL navigation (reader [d33CK8uuji0],[7fbY8k9Mz3M]) for core — they assume a real shell absent on Workers.

---

## 4. Use-case walkthrough — customer-support agent with a local KB + skills

The mindstudio:35,49 "support agent with local KB + policy checklist" example. Developer-facing API after the three additions:

```ts
import { defineAgent, defineTool, FilePersistentMemoryStore } from '@kuralle-agents/core';
import { defineSkill } from '@kuralle-agents/skills';
import { z } from 'zod';

// Local KB lookup — a normal durable tool (grounding rule: tools return data only)
const kbLookup = defineTool({
  name: 'kb_lookup',
  description: 'Search the support knowledge base. Returns matching article text.',
  input: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ articles: await kb.search(query) }), // data only
});

// SOP as a skill, NOT a 1000-line prompt (openai:43-56; framework rule: SOP→flow/skill)
const refundPolicy = defineSkill({
  id: 'refund-policy',
  description: 'How to process or decline a refund request.',
  when: 'customer asks for a refund, return, or chargeback',
  body: `1. Verify order via kb_lookup.\n2. If within 30 days → approve.\n3. Else explain policy and offer store credit.\n4. Never promise a timeline you cannot confirm.`,
});

export const supportAgent = defineAgent({
  id: 'support',
  model: anthropic('claude-...'),
  instructions: 'You are Acme support. Be concise. If unsure, say so and search the KB.',
  globalTools: { kbLookup },          // always model-visible (agentConfig.ts:28-33)
  skills: [refundPolicy],             // NEW — load_skill exposes id+description only
  workspace: {                        // NEW — file-backed working memory
    store: new FilePersistentMemoryStore(),     // Node; CfMemoryStore on Workers
    autoLoad: [{ scope: 'user', key: 'USER' }], // injects USER.md each session
  },
});
```

Runtime behavior (grounded in the wiring above): the speaking turn sees `kb_lookup`, `load_skill` (listing `refund-policy: How to process or decline a refund request`), and `memory_block`. The model loads `refund-policy` only when a refund is mentioned (progressive disclosure), follows the SOP, calls `kb_lookup` for data, and can write a note to `USER.md` via `memory_block` for next session. No SOP bloats the system prompt; the "policy checklist" lives in a skill, the KB in a tool, the per-user state in the workspace — the exact taxonomy split the sources prescribe.

Same code runs on Workers by swapping `store: new CfMemoryStore(env)` — every other line is identical.

---

## 5. Open questions

1. **Skill auto-selection vs explicit `load_skill`.** Reader [hcm5zIWASCM] says "never hardcode sequencing — let descriptions steer." The `load_skill` tool defers selection to the model. But should a skill with a strong `when` ever auto-inject (like a flow route)? Recommend: no — keep it model-driven; a `when` that must fire deterministically is a *flow*, not a skill (framework rule: SOP in flows).
2. **Skill evaluation harness.** Reader [KijChx7q2nY]: skills can *reduce* performance; evaluate with/without routinely. Should `@kuralle-agents/skills` ship an eval helper that runs the existing `eval/` harness with skills toggled? Likely yes, follow-up.
3. **Proactive compaction.** kuralle compacts only on overflow (contextOverflow.ts). Readers ([KijChx7q2nY] OpenHands) show proactive summarization saves cost *and* maintains SWE perf. Separate workstream — out of scope here but the highest-value "Partial" row.
4. **Workspace mid-session injection.** The blocks types describe a "frozen-snapshot once per session" to preserve prompt-cache (blocks/types.ts:15-18). Confirm gather.ts can load-once-per-session without breaking the existing `promptCache.ts` hit path.
5. **Should `skills` live on `AgentConfig` or `HarnessConfig`?** Skills are agent-scoped (a support agent's SOPs ≠ a triage agent's). Recommend `AgentConfig` (mirrors `globalTools`).

## 6. Risks / non-goals

- **Non-goal: multi-agent dispatcher.** The sources' keystone is "consolidate the brain" — single agents beat multi-agent on average (coordination tax), and split-brain caused "unpredictable behavior" (readers [K4-flzsPraE],[KijChx7q2nY]). kuralle's handoff/composition is enough; do not build a swarm orchestrator.
- **Non-goal: shell/CLI/RLM in core.** CLI-over-MCP and Python-REPL navigation (readers [d33CK8uuji0],[7fbY8k9Mz3M]) assume a POSIX shell — absent on Workers. Keep core portable; these belong in a Node-only optional package if ever.
- **Risk: skill bloat re-creates the manual.** Mitigate by keeping only id+description+when in context (the whole point) and by the eval-with/without discipline (Q2).
- **Risk: stale-dist / publish-together (CLAUDE.md).** `@kuralle-agents/skills` and the cf `CfMemoryStore` must publish in the same release as the core wiring, or scaffolds break (documented "version + publish together" gotcha).
- **Risk: prompt-cache regression** from workspace auto-load (Q4) — gate behind the frozen-snapshot pattern the types already specify.
- **Surgical-change discipline:** §3.2/§3.3 are *wiring of existing leaves* (memory/blocks, contextOverflow, escalation), not rewrites. Only `@kuralle-agents/skills` is net-new, and it is one interface + one `defineTool`.
