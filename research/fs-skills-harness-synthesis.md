# Filesystem · Skills/Scripts · Agentic Harness — research synthesis & index

**Date:** 2026-06-07 · **Author:** research workflow (5 grounded pipelines, 21 agents) + reconciliation
**Question:** How do Flue / Hare / cloudflare-agents / Mastra / Pi / Mintlify build *filesystem*, *Skills/Scripts*, and *agent-loop/harness* primitives — and what minimal, grounded additions let **kuralle-core be the reusable agentic conversational harness** (local knowledge bases, Skills, Scripts), the way Claude Code / OpenClaw / Hermes build on Pi?

All claims below are file:line-verified against the cloned repos (`research/{flue,hare,cloudflare-agents-sdk,mastra,pi}`, gitignored) and `packages/kuralle-core`. Spot-checked keystones held exactly (see "Verification").

---

## The five plans (read these for detail)

| # | Plan | What it argues |
| - | ---- | -------------- |
| 1 | [`filesystem-primitives-plan.md`](./filesystem-primitives-plan.md) | A portable ~15-method async `FileSystem` interface is the irreducible primitive everything (model tools, git, skills, RAG) composes over. Copy cloudflare-agents' interface + `InMemoryFs` verbatim into `@kuralle-agents/fs`; expose one durable `defineTool` speaking `ls/cat/grep/find/read/write/edit`; add `AgentConfig.workspace?: FileSystem`. KB use case → read-only `KnowledgeFs` over `@kuralle-agents/rag` (cat=chunk reassembly, grep=coarse-DB→fine-BM25, RBAC=tree-pruning). Hare = the anti-pattern. |
| 2 | [`skills-and-scripts-plan.md`](./skills-and-scripts-plan.md) | Anthropic Agent Skills = folder + `SKILL.md` frontmatter + 3-level progressive disclosure. Flue & Pi both implement exactly this. New `@kuralle-agents/skills` + a `SkillsCapability` that copies the in-tree `AutoRetrieveCapability` on-demand-tool pattern. "Scripts" = `defineTool`/flows referenced by name (no portable bash). One field: `AgentConfig.skills?`. |
| 3 | [`pi-coding-agent-primitives.md`](./pi-coding-agent-primitives.md) | Pi splits `packages/agent` (reusable loop+harness) from `packages/coding-agent` (app) — kuralle-core should be the former. The 4 missing primitives: injected `fs/exec` seam (`ExecutionEnv = FileSystem & Shell`), usage-driven compaction, lazy file-backed Skills, per-message id/parent identity. New `@kuralle-agents/workspace`. |
| 4 | [`harness-engineering-plan.md`](./harness-engineering-plan.md) | kuralle-core *already* maps to the full harness-engineering taxonomy (loop, flows=routing, tools, sessions/memory, hooks, validation, grounding) — **every row exists except Skills**, and two primitives are **built-but-orphaned**. Adds `@kuralle-agents/skills` + a `RecoveryPolicy` budget; rejects multi-agent dispatch ("consolidate the brain") and shell-in-core. |
| 5 | [`kuralle-vs-pi-gap.md`](./kuralle-vs-pi-gap.md) | Primitive gap table. Kuralle is *ahead* on durability (exactly-once effect log), capabilities, AI-SDK-native streaming; at parity on inner loop/tool-engine/session. 4 hard gaps: no FS+Shell seam, no skills, flat `RunState.messages` vs Pi's append-only session tree, no proactive compaction/env injector. Phased roadmap. |

**Earlier related plans** (same folder, prior session): [`deploy-primitives-plan.md`](./deploy-primitives-plan.md), [`config-loaded-agents-plan.md`](./config-loaded-agents-plan.md).

**Raw sources:** `research/_sources/web/{mintlify-chromafs,openai-harness-engineering,mindstudio-harness-engineering}.md`; `research/_sources/transcripts/*.txt` + `MANIFEST.md` (10 videos incl. the Pi architecture deep-dive `gTeujlv8qK0`).

---

## Cross-cutting findings (what all five agree on)

1. **The agent's primary interface is a filesystem.** Mintlify's line — *"grep, cat, ls, find are all an agent needs"* — is borne out by every codebase. The irreducible primitive is a **narrow async `FileSystem` interface** (read/write/exists/stat/list/mkdir/rm/...). Identical on Node and Workers; **only the backend swaps**. cloudflare-agents (`packages/shell/src/fs/interface.ts:52`) and Pi (`packages/agent/src/harness/types.ts:268`) have nearly the same shape; Mastra has a richer one with composite/mount.

2. **Portability = interface in core, one `node:*` boundary at the edge.** cloudflare-agents' fs is explicitly zero-`node:` ("safe for browser bundles and Workers", `path-utils.ts:4`) — it's a *Cloudflare* SDK, so Workers-portability is proven, not hoped. This is the design to copy. Node-specific impls (real fs, child_process) live in the adapter package, never in core.

3. **Skills are settled and identical across Flue + Pi + Anthropic:** a folder + `SKILL.md` (YAML frontmatter: `name` ≤64, `description` ≤1024 — verified `flue/.../skill-frontmatter.ts:43,67`) + **3-level progressive disclosure** (metadata always → body on trigger → resources on read). kuralle-core has the perfect host already: the **`Capability` interface** (`capabilities/index.ts:87`) + the **on-demand-tool pattern** of `AutoRetrieveCapability.ts` (turns retrieval into a `search_knowledge_base` tool whose result flows back). Skills = the same trick with a `load_skill` tool.

4. **"Scripts" should NOT be portable bash in core.** Every plan independently concluded that real shell breaks Workers portability *and* Kuralle's own rules ("tools return data only", "SOP in flows, not prompts"). The conversational-framework answer: a Skill's "script" is a named `defineTool` effect / flow, allow-listed by the skill (reuses the `globalTools` allow-list posture, `agentConfig.ts:28`). just-bash gives `grep/cat/ls/find` over the VFS **without** a real shell — that is the KB sweet spot (Mintlify ChromaFs proves it).

5. **kuralle-core is closer than it looks — and has orphaned primitives.** The harness-eng pipeline's sharpest catch: `FilePersistentMemoryStore` (`memory/blocks/FilePersistentMemoryStore.ts:35`) + `buildMemoryBlockTool` (`memoryBlockTool.ts:86`) are **exported (`index.ts:131,133`) but never consumed by `runtime/`** (verified: zero refs). A filesystem-as-memory primitive already exists, unwired. Don't duplicate it.

6. **Reject multi-agent dispatch as the default (the "consolidate the brain" lesson).** Two independent harness sources (Omni/Blobby talk `K4-flzsPraE`, OpenAI article) warn that splitting a task across sub-agents creates "split-brain" failures; the fix was pulling tools up into one outer harness. Kuralle's flow-based single-loop design is *already* the recommended shape — keep it.

---

## Reconciliation: the one tension to resolve

The pipelines proposed **two overlapping package shapes**, because they came at it from different angles:

- **`@kuralle-agents/fs`** (plan 1): just `FileSystem` (no shell), read-only `KnowledgeFs` over RAG — optimized for the *conversational KB* use case.
- **`@kuralle-agents/workspace`** (plans 3 & 5): `ExecutionEnv = FileSystem & Shell` copied from Pi — optimized for *Pi-class parity* (a coding-style workspace).

**Recommended resolution (my synthesis):**

> Ship **`@kuralle-agents/fs`** = the portable `FileSystem` interface (copy cloudflare-agents verbatim) + `InMemoryFs` + `KnowledgeFs` (read-only, over `@kuralle-agents/rag`). Add **one** field `AgentConfig.workspace?: FileSystem` and **one** durable `defineTool` exposing `ls/cat/grep/find/read/write/edit` (data-returning, `EROFS`/`ENOENT` as model-recoverable errors). **Keep `Shell` out of the core interface** — it is the contested, non-portable part and not needed for the conversational/KB goal. Pi's `ExecutionEnv = FileSystem & Shell` shows the *seam*: if a Node-only coding workspace is ever wanted, add an optional `Shell` capability later behind a `NodeExecutionEnv` adapter — it composes onto the same `FileSystem` without reshaping anything.

So: **`FileSystem` now, `Shell` later and optional.** Field name `workspace` (all plans converged on it); package name `@kuralle-agents/fs`. Skills (`@kuralle-agents/skills`) ride on top via the `Capability` pattern. Reconcile the workspace backend with the **existing** `memory/blocks` store rather than inventing a parallel one.

---

## Recommended sequencing (minimal, grounded, additive — no breaking changes)

1. **`@kuralle-agents/fs`** — copy cloudflare-agents `FileSystem` interface + `path-utils` + `InMemoryFs` (zero `node:` deps). Add `AgentConfig.workspace?: FileSystem` + `createFsTool({fs, readOnly})` built on `defineTool` (`tools/effect/defineTool.ts:13`). Auto-register into the tool surface alongside `globalTools` (`run-context.ts:89`). *Highest value, lowest risk.*
2. **`KnowledgeFs`** read-only adapter in `@kuralle-agents/rag` — `cat`=chunk reassembly by `chunk_index`, `grep`=coarse store-query → fine in-mem BM25, RBAC=tree-pruning, `EROFS` on write. *Delivers the customer-support-agent-over-local-KB use case.*
3. **`@kuralle-agents/skills`** — `defineSkill` + `SkillsCapability` (copy `AutoRetrieveCapability` on-demand-tool pattern; frontmatter parser ported from `flue/.../skill-frontmatter.ts`). `AgentConfig.skills?: SkillSource`. Scripts = allow-listed `defineTool`/flows. Default `MemorySkillStore` (Node+CF); `FsSkillStore` rides on the VFS.
4. **Wire / reconcile memory** — promote the orphaned `FilePersistentMemoryStore`/`buildMemoryBlockTool` into the `workspace` story instead of a second store; consume it in `runtime/`.
5. **(Optional, later) RecoveryPolicy** on `ToolExecutor` (reuse `recoverFromContextOverflow`, default `maxRetries:0` = no behavior change) and **proactive compaction**; **Shell** capability for a Node coding workspace; **session-tree** (`parentId` on `RunState`) — these are the deeper Pi-parity items, deferred so they never block 1–3.

**Non-goals (explicit):** real bash/shell in core; multi-agent dispatch as default; a second session-storage format; TUI/CLI; replacing flows.

---

## Verification (anti-hallucination)
Spot-checked the load-bearing citations against source — all held: cloudflare-agents `FileSystem` (`interface.ts:52`, Workers-clean per `path-utils.ts:4`); Flue skill limits (`skill-frontmatter.ts:43,67`); Pi `ExecutionEnv extends FileSystem, Shell` (`types.ts:332`); kuralle `RunContext.globalTools` (`run-context.ts:89`), `Capability`+`getTools` (`capabilities/index.ts:87`), `AutoRetrieveCapability` on-demand tool; orphaned `FilePersistentMemoryStore`/`buildMemoryBlockTool` exported (`index.ts:131,133`) with zero `runtime/` consumers. One minor doc inaccuracy noted: skills plan says `getSections()`; the real Capability method is `getPromptSections()` (`capabilities/index.ts:92`) — mechanism correct, name to fix when implementing.
