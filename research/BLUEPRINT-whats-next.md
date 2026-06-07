# Blueprint — what's next for kuralle-core as a conversational agentic harness

**Date:** 2026-06-07 · Synthesizes all research in `research/` (verified, file:line-grounded).
**Thesis:** kuralle-core should be the reusable **conversational harness** — the layer products build on, the way Claude Code / OpenClaw / Hermes build on Pi's `packages/agent`. The research says kuralle is *closer than it looks* (it already maps the whole harness-engineering taxonomy and is *ahead* on durability/streaming), with a small number of high-leverage gaps and one foundational cleanup.

Read first: [`fs-skills-harness-synthesis.md`](./fs-skills-harness-synthesis.md) and [`tools-vs-effecttools-analysis.md`](./tools-vs-effecttools-analysis.md).

---

## The two threads, in one picture

1. **Tool-model is muddier than it should be.** Three fields (`tools`, `effectTools`, `globalTools`) but only **two concepts**: a durable tool primitive (`defineTool` → exactly-once via the `ctx.tool`/`replayOrExecute` journal) and a visibility/safety policy. The raw `tools?: ToolSet` field is a **non-durable footgun** (its `execute` is auto-run by `streamText`, bypassing the journal; never registered in the executor). Fix this *before* piling new tools on top.
2. **A few harness primitives are missing or orphaned.** No FileSystem/workspace, no Skills; and a filesystem-as-memory primitive (`FilePersistentMemoryStore`) is built but unwired. These are the additive layers that unlock "support agent over a local knowledge base + Skills/Scripts."

Everything below is **additive and Node+Cloudflare-portable** except Phase 0 (a pre-1.0 breaking rename, acceptable per kuralle norms). These are **plans, not RFCs** — promote each phase through `/rfc-writer` before building.

---

## Phase 0 — Tool-model cleanup *(foundational; do first)*
Source: `tools-vs-effecttools-analysis.md` (verdict: rename-or-restructure).

Why first: every new capability (fs tool, `load_skill`, scripts) is a `defineTool` and lands on the tool surface. Clean the surface before extending it; the Workers-crypto fix is a prerequisite for *any* durable tool on CF.

- Rename **`effectTools` → `tools`** (the durable primitive becomes THE tool field). Keep **`globalTools`** as the visibility/safety allow-list (ADR-0001). Delete the raw `ToolSet` field.
- Third-party AI SDK tools enter via a named adapter **`wrapAiSdkTool(t)`** that captures `execute` for the journal (`ctx.tool` → `replayOrExecute`, `runtime/ctx.ts:208`).
- Journal-route the host-reply path: `runtime/agentReply.ts:14` must strip `execute` (`toolToAiSdk`) and register executors into `CoreToolExecutor` (`runtime/Runtime.ts:118`), so off-flow tools are durable too.
- **CI guard** (sibling to `scripts/check-no-stale-text-delta.sh`): fail if anything reaching `streamText({tools})` still has `execute` intact.
- **Workers portability:** replace `node:crypto` `createHash`/`randomUUID` (`runtime/durable/idempotency.ts:1`, `runtime/ctx.ts:1`) with a WebCrypto fallback (`crypto.subtle.digest` / `crypto.randomUUID`) or require `nodejs_compat` in `@kuralle-agents/cf-agent`.

Outcome: one honest tool concept (`tools` = durable, `globalTools` = visibility), no silent non-durable path, journal portable to Workers.

## Phase 1 — `@kuralle-agents/fs` (the FileSystem primitive)
Source: `filesystem-primitives-plan.md`.

- Copy cloudflare-agents' `FileSystem` interface + `path-utils` + `InMemoryFs` verbatim (zero `node:` deps, Workers-clean). Add `AgentConfig.workspace?: FileSystem`.
- One durable `defineTool` exposing `ls/cat/grep/find/read/write/edit` (data-returning; `ENOENT`/`EROFS` as model-recoverable errors). Auto-register alongside `globalTools`.
- **Reconcile** with the orphaned `FilePersistentMemoryStore`/`buildMemoryBlockTool` (`memory/blocks`, exported `index.ts:131,133`, zero `runtime/` consumers) — absorb it, don't duplicate.

## Phase 2 — `KnowledgeFs` over RAG *(the headline use case)*
Source: `filesystem-primitives-plan.md` §KnowledgeFs.

- Read-only adapter in `@kuralle-agents/rag`: `cat` = chunk reassembly by `chunk_index`; `grep` = coarse store-query → fine in-mem BM25; RBAC = path-tree pruning; `EROFS` on write (Mintlify ChromaFs pattern).
- Delivers: **a customer-support agent that explores a local knowledge base via `ls/cat/grep`** instead of only top-K RAG.

## Phase 3 — `@kuralle-agents/skills` (Skills & Scripts)
Source: `skills-and-scripts-plan.md`.

- `defineSkill` + a **`SkillsCapability`** that copies the in-tree `AutoRetrieveCapability` on-demand-tool pattern (a `load_skill` tool; 3-level progressive disclosure). Frontmatter parser ported from `flue/.../skill-frontmatter.ts` (`name`≤64/`desc`≤1024). Add `AgentConfig.skills?`.
- **"Scripts" = allow-listed `defineTool`/flows referenced by name** (no portable bash — respects "tools return data only / SOP in flows"). `MemorySkillStore` (Node+CF default); `FsSkillStore` rides on Phase 1's VFS.
- Fix-on-implement: the plan says `getSections()`; the real Capability method is `getPromptSections()` (`capabilities/index.ts:92`).

## Phase 4 — Pi-parity deepening *(optional, later; never blocks 1–3)*
Source: `pi-coding-agent-primitives.md`, `kuralle-vs-pi-gap.md`.

- `RecoveryPolicy` budget on `ToolExecutor` (reuse `recoverFromContextOverflow`; default `maxRetries:0` = no behavior change).
- Proactive **usage-driven compaction** at turn boundaries.
- Optional **Node-only `Shell`** capability composing onto the same `FileSystem` (Pi's `ExecutionEnv = FileSystem & Shell` seam) — for a coding-style workspace only.
- **Session-tree**: `parentId` on `RunState` + replay-to-root (enables forking) — the deepest change, do last.

Rejected as default: **multi-agent dispatch** — both the OpenAI article and the Omni/Blobby talk warn of sub-agent "split brain"; kuralle's single flow-loop is already the recommended shape.

---

## Recommended starting point
**Phase 0 then Phase 1.** Phase 0 is small, removes a real correctness footgun, and makes the tool surface honest + Workers-durable; Phase 1 is the highest-value, lowest-risk new capability and everything else (KnowledgeFs, Skills) composes on it. Promote Phase 0+1 as a single `/rfc-writer` RFC ("Tool model + FileSystem primitive"), since the rename and the new fs tool touch the same surface.

## Portability rule (applies to every phase)
Interface in `kuralle-core`; the single `node:*` boundary in the adapter package; a Workers impl (DO/KV/R2 or WebCrypto) behind the same interface. No `node:*` leak into core.
