# ADR 0006 — Reframe the filesystem; wire working memory (Mastra-informed)

**Status:** Accepted · **Date:** 2026-06-07 · **Supersedes (in part):** the FS-as-knowledge-layer framing in `research/fs-skills-harness-synthesis.md` / RFC-03.

## Context

We built `@kuralle-agents/fs` (`InMemoryFs` + a `workspace` tool) and `KnowledgeFs` (a read-only filesystem over the RAG store) on the thesis "agents converge on filesystems." Working backwards from the **customer-support** use case exposed two problems:

1. **An FS is the wrong primitive for support *retrieval*.** A support agent doesn't explore unknown structure (the coding-agent / Mintlify-docs case); it needs the right grounded answer fast. `ls→grep→cat` is 3 round-trips and lexical-only, where semantic retrieval (RAG/CAG) is one shot and more accurate — and multi-turn tool exploration is a latency killer for voice. `KnowledgeFs` makes retrieval *impersonate* a filesystem and gets the worst of both (in-memory full load, BM25/regex only, navigation turns).
2. **We have an orphaned, better-fitting memory primitive.** `PersistentMemoryStore` + `buildMemoryBlockTool` (`memory/blocks/`, scopes user/agent/shared, autoLoad USER+MEMORY) is a complete Letta/MemGPT-style **working-memory** system — exported but never wired into the runtime. Cross-session memory ("this caller phoned last week about X") is a real, central support need that this already models.

Mapping the support agent's actual "desk" to primitives shows ~6 of 8 needs are served by primitives Kuralle already has (RAG/CAG, typed tools, flows, durable tools, persistent memory). The FS is clearly right for only two: **the substrate for Skills/Scripts**, and **bundled local files + a scratchpad**.

We also studied **Mastra's memory** (`@mastra/memory`): a `Memory` with `workingMemory` (a maintained `template` block), `semanticRecall` (vector, `scope: 'thread' | 'resource'`), threads/resourceId, and observational (async-extract) processors. Its standout idea Kuralle lacks: a **working-memory template** and explicit **resource-vs-thread scope**.

## Decision

### A. Reframe the filesystem (demote from foundation to power-tool)
- `@kuralle-agents/fs` stays, with its role narrowed to: (1) **the substrate Skills/Scripts mount on** (the original motivation), and (2) **bundled local files + a writable `/scratch`** the agent reads/writes within a session.
- **Support retrieval goes through RAG/CAG** (existing `AgentKnowledge` + `AutoRetrieveCapability`), not the FS.
- **`KnowledgeFs` is repositioned as a thin "open this page" reader, not a search engine.** Retrieval narrows to a page → `cat` it for exact text. Stop marketing grep-over-the-corpus (BM25/regex) as the retrieval path; that lexical, in-memory, multi-turn design is the unusable part.
- **The `workspace` tool defaults to read-only.** Mutating ops (`write`/`edit`) are opt-in (`workspace: { fs, readOnly: false }`) — this also resolves the ADR-0001 tension (a read-only workspace is safe to expose in `globalTools`; a read-write one is not auto-exposed).

### B. Wire working memory (the orphan), Mastra-informed
- Wire the existing `PersistentMemoryStore` / blocks into the runtime under **`AgentMemory.workingMemory?: WorkingMemoryConfig`** (extends the existing `AgentMemory`; semantic `preload`/`ingest` stays the other axis). Reconcile — do not add a parallel store.
- On session start: load the `autoLoad` blocks (default USER@user, MEMORY@agent) for the right owner (`user`/`shared` → `session.userId` = the *resource*; `agent` → `agent.id`), inject them as a **working-memory system-prompt section**, and register `buildMemoryBlockTool` so the agent maintains its own memory (safety-scanned writes via `scanMemoryWrite`).
- Adopt the two Mastra refinements: a per-block **`template`** (seed structure the agent fills in, e.g. a USER profile) and treating **`user`/`shared` scope as the resource axis** (shared across this user's sessions/threads) vs **`agent`** scope.
- Non-goal for this cut: rebuilding semantic recall (already exists), Mastra's observational-memory processor, and threads-as-first-class (Kuralle uses sessions; resource = userId).

## Consequences
- The FS stops pretending to be the knowledge layer; support agents ground via RAG/CAG + carry Skills/local files on the FS + remember via working-memory blocks. Each need uses its sharpest primitive.
- One new field (`AgentMemory.workingMemory`), one wiring site, the block tool auto-registered — minimal, additive (default off).
- `KnowledgeFs` BM25/grep-as-retrieval is deprecated in positioning (kept as a reader); no hard removal.

## Non-goals / rejected
- FS as the retrieval/knowledge layer for support (rejected — RAG/CAG wins).
- A second memory store (rejected — wire the existing one).
- Real shell, threads-as-entities, observational-memory processor (deferred).
