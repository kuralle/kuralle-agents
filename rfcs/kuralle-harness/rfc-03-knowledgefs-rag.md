# RFC: `KnowledgeFs` — a read-only filesystem over the RAG store

**Category:** New Feature
**Author:** kuralle-harness program
**Date:** 2026-06-07
**Status:** Draft
**Reviewers:** (program)
**Related:** `research/filesystem-primitives-plan.md` (§KnowledgeFs), `research/_sources/web/mintlify-chromafs.md`, `rfcs/kuralle-harness/rfc-02-filesystem-primitive.md`
**Depends on:** RFC-02 (`FileSystem` interface + `createFsTool`).

---

## 1. Problem Statement

RAG returns top-K chunks; it cannot answer questions whose answer spans pages or needs exact syntax that didn't rank (`research/_sources/web/mintlify-chromafs.md`). The fix Mintlify proved: expose the existing vector store **as a filesystem** so the agent explores it with `ls/cat/grep/find` — instant, ~$0 marginal cost (reuses the DB), built-in RBAC. Kuralle already has the store (`@kuralle-agents/rag`: `VectorStoreCore` `types.ts:274`, `KnowledgeChunk` `types.ts:7`, `BM25Index` `search/index.ts:90`).

Success: a `KnowledgeFs` implementing the RFC-02 `FileSystem` interface (read-only) over a `VectorStoreCore`, so `defineAgent({ workspace: new KnowledgeFs(store) })` lets a customer-support agent answer by `grep`+`cat` over a local knowledge base, with writes throwing `EROFS` and RBAC by path-tree pruning.

## 2. Background

ChromaFs pattern (`research/_sources/web/mintlify-chromafs.md`), mapped to kuralle-rag:
- **Path-tree manifest:** structure (which "files" exist) is a cheap in-memory tree; content is fetched lazily on `cat`.
- **`cat` = chunk reassembly:** fetch all chunks for a page slug, sort by `chunk_index`, join. `KnowledgeChunk` (`types.ts:7`) carries the page/index metadata; reassembly is a metadata query.
- **`grep` = two-stage:** coarse filter via `VectorStoreCore` query (`VectorQueryParams` `types.ts:200`, `$contains`/metadata filter via `VectorFilter` `types.ts:240`) → fine in-memory regex/BM25 (`BM25Index` `search/index.ts:90`) over the candidate chunks.
- **RBAC = tree-pruning:** prune slugs the caller can't access *before* building the tree; apply a matching `VectorFilter` to all queries → the agent can't even reference a pruned path.
- **Read-only (`EROFS`):** every write throws → stateless, multi-tenant-safe, no session cleanup.

This is a pure adapter: no new storage, no new infra. It is the headline use case of the whole program.

## 3. Strict Requirements

- REQ-1: `KnowledgeFs` class in `@kuralle-agents/rag` (`packages/kuralle-rag/src/fs/`) implements the RFC-02 `FileSystem` interface, constructed from a `VectorStoreCore` (+ optional `BM25Index`, + access filter).
- REQ-2: Read ops only. `writeFile`/`appendFile`/`mkdir`/`rm`/`cp`/`rename` throw `EROFS`. `readdir`/`stat`/`exists`/`readFile` work.
- REQ-3: `readFile(slug)` reassembles the page from its chunks (all chunks with matching page metadata, sorted by `chunk_index`, joined). Results cached per slug for the session.
- REQ-4: A path-tree is built once (from store metadata or a stored manifest doc) into in-memory `Set<path>` + `Map<dir, children>`; `ls`/`find`/`stat`/`exists` resolve from memory with no store call.
- REQ-5: `grep` (via the RFC-02 fs tool) uses the store as a coarse filter (`VectorStoreCore` query with a contains/metadata `VectorFilter`), then fine-filters candidate chunks in memory (regex or `BM25Index`).
- REQ-6: RBAC: an optional `accessFilter` (a `VectorFilter` + slug predicate) prunes the tree at build time and is ANDed into every store query. A pruned path is invisible to `ls` and unreadable by `cat`.
- REQ-7: Works on Node and Workers (depends on the underlying `VectorStoreCore` impl; `KnowledgeFs` itself adds no `node:*`).
- REQ-8: A live test: an agent with `workspace: new KnowledgeFs(store)` answers a multi-page question by `grep`+`cat`; a write attempt returns `EROFS`; a pruned slug is absent. `typecheck:all` + `test` green.

## 4. Interface Specification

### 4.1 `KnowledgeFs` (new)
- **Location:** `packages/kuralle-rag/src/fs/KnowledgeFs.ts`
- **Signature:** `new KnowledgeFs(opts: { store: VectorStoreCore; bm25?: BM25Index; accessFilter?: KnowledgeAccessFilter; manifestKey?: string })`
- **Behavior:** implements `FileSystem` read ops over the store; write ops throw `EROFS`.
- **Error cases:** unknown slug → `ENOENT`; any write → `EROFS`; store error → surfaced as a tool error.

### 4.2 `KnowledgeAccessFilter` (new)
- **Location:** `packages/kuralle-rag/src/fs/access.ts`
- **Signature:** `interface KnowledgeAccessFilter { vectorFilter?: VectorFilter; allowSlug?(slug: string): boolean }`
- **Behavior:** prunes the tree + ANDs into queries.

### 4.3 grep coarse hook (fs tool integration)
- **Location:** RFC-02 `createFsTool` recognizes an optional `fs.search?(pattern, opts)` capability; `KnowledgeFs.search` implements the coarse store query returning candidate slugs/chunks for the fine pass.
- **Signature:** `KnowledgeFs.search(pattern: string, opts?: { limit?: number }): Promise<{ slug: string; chunkIndex: number; text: string }[]>`

## 5. Architecture and System Dependencies

### 5.1 Structural changes
New `packages/kuralle-rag/src/fs/{KnowledgeFs,access,index}.ts`. RFC-02's `createFsTool` gains an optional `fs.search` coarse hook (additive, backward compatible with `InMemoryFs` which omits it → in-memory scan).

### 5.2 Dependencies
`@kuralle-agents/rag` already depends on core; it now also imports the `FileSystem` interface type (from `kuralle-core/src/types/filesystem.ts`, per RFC-02 §5.2). Reuses existing `VectorStoreCore`, `BM25Index`, `VectorFilter`.

### 5.3 Data/schema
Optional `__path_tree__`-style manifest doc in the store (Mintlify pattern) for fast bootstrap; else derive the tree from chunk page metadata. No migration required for stores that already have page/chunk metadata.

### 5.4 Network/performance
`ls/find/stat` = zero store calls (in-memory tree). `cat` = one metadata query per slug, cached. `grep` = one coarse query + in-memory fine pass → milliseconds even for large KBs (the Mintlify result).

## 6. Pseudocode

```
KnowledgeFs(store, bm25, accessFilter, manifestKey):
  tree = loadManifest(store, manifestKey) ?? deriveTreeFromChunkMetadata(store)
  tree = prune(tree, accessFilter)        # RBAC at build time

  readdir(path)  = tree.children(path)                     # in-memory
  exists/stat    = tree.has(path)                          # in-memory
  readFile(slug):
     if not tree.has(slug): throw ENOENT
     if cache[slug]: return cache[slug]
     chunks = store.fetchByPage(slug, filter=accessFilter.vectorFilter)
     page = chunks.sortBy(chunk_index).map(.text).join("")
     cache[slug] = page; return page
  search(pattern, {limit}):
     coarse = store.query({ contains: pattern, filter: accessFilter.vectorFilter, topK: limit })
     return coarse.map(slug, chunkIndex, text)             # candidates for fine pass
  writeFile/append/mkdir/rm/cp/rename: throw EROFS
```

## 7. Code Blueprint

```ts
// packages/kuralle-rag/src/fs/KnowledgeFs.ts
import type { FileSystem, FsStat, FileSystemDirent } from '@kuralle-agents/fs';
import type { VectorStoreCore, VectorFilter } from '../types.js';

const EROFS = () => Object.assign(new Error('EROFS: read-only knowledge filesystem'), { code: 'EROFS' });

export class KnowledgeFs implements FileSystem {
  // tree + cache built in constructor from store metadata (+ accessFilter prune)
  async readdir(path: string): Promise<FileSystemDirent[]> { /* in-memory */ }
  async readFile(slug: string): Promise<string> { /* reassemble chunks by chunk_index, cache */ }
  async exists(path: string) { return this.paths.has(norm(path)); }
  async stat(path: string): Promise<FsStat> { /* in-memory */ }
  async search(pattern: string, opts?: { limit?: number }) { /* coarse store query */ }
  // writes:
  async writeFile() { throw EROFS(); }
  async appendFile() { throw EROFS(); }
  async mkdir() { throw EROFS(); }
  async rm() { throw EROFS(); }
  async cp() { throw EROFS(); }
  async rename() { throw EROFS(); }
}
```

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C1 | `KnowledgeFs` read ops over `VectorStoreCore` (tree build from chunk metadata; `readdir/stat/exists`) | `packages/kuralle-rag/src/fs/KnowledgeFs.ts`, `fs/index.ts` | REQ-1,REQ-4 | `ls`/`stat` resolve from memory; no store call |
| C2 | `readFile` = chunk reassembly by `chunk_index` + per-slug cache | `fs/KnowledgeFs.ts`, `test/knowledgefs.test.ts` | REQ-3, `test:kfs-cat` | multi-chunk page reassembles in order; second read hits cache |
| C3 | Write ops throw `EROFS` | `fs/KnowledgeFs.ts` | REQ-2, `test:kfs-erofs` | every write/mutate op throws `EROFS` |
| C4 | `search` coarse hook + RFC-02 fs tool grep two-stage wiring | `fs/KnowledgeFs.ts`, `packages/kuralle-fs/src/tool.ts` | REQ-5, `test:kfs-grep` | grep returns hits via coarse query + fine regex/BM25 |
| C5 | RBAC `KnowledgeAccessFilter` (prune tree + AND into queries) | `fs/access.ts`, `test/knowledgefs-rbac.test.ts` | REQ-6, `test:kfs-rbac` | pruned slug absent from `ls` and `cat` → `ENOENT` |
| C6 | Optional manifest (`__path_tree__`) bootstrap + fallback to metadata derivation | `fs/KnowledgeFs.ts` | REQ-4 | tree builds from manifest when present, else derived |
| C7 | Live example + Workers note + docs/changeset | `packages/kuralle-rag/examples/support-kb-agent.ts`, `packages/kuralle-rag/guides/*`, `.changeset/*` | REQ-7,REQ-8, `test:kfs-agent` | agent answers a multi-page question via grep+cat in a live run |

## 9. Validation and Testing

### 9.0 Validation contract
| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..8 | §3 | as stated |
| test:kfs-cat | §9.1 | `cat slug` reassembles chunks in `chunk_index` order; cached on reread |
| test:kfs-erofs | §9.1 | all write ops throw `EROFS` |
| test:kfs-grep | §9.1 | grep returns coarse+fine hits across multiple pages |
| test:kfs-rbac | §9.1 | a slug excluded by `accessFilter` is invisible (`ls`) and unreadable (`cat`→ENOENT) |
| test:kfs-agent | §9.1 | end-to-end: agent with `workspace: KnowledgeFs` answers a multi-page question |
| cmd:gate | §9.3 | `bun run typecheck:all && bun run test` green |

### 9.1 Fail-to-pass tests
- `test:kfs-cat`, `test:kfs-erofs`, `test:kfs-grep`, `test:kfs-rbac`, `test:kfs-agent` (seed a small in-test `VectorStoreCore` fake or the in-memory store).

### 9.2 Regression
- `packages/kuralle-rag/test/**` (existing retrieval/store tests stay green; KnowledgeFs is additive).

### 9.3 Validation commands
```bash
bun run build && bun run typecheck:all && bun run test
bun packages/kuralle-rag/examples/support-kb-agent.ts   # live: grep+cat answer
```

## 10. Security Considerations
RBAC by tree-pruning is the security model: a user without access never sees the path (stronger than post-filtering). Read-only → no mutation/corruption across tenants. The `accessFilter` must be derived from a trusted session token, not model input — document this; the model cannot widen its own filter.

## 11. Rollback and Abort Criteria
- Abort if: chunk metadata in the target store lacks page/`chunk_index` info needed for reassembly — escalate (the store schema is a prerequisite); do not fabricate ordering.
- Abort if: RBAC pruning can be bypassed by a crafted path (traversal) — block; this is a security gate.
- Rollback: `KnowledgeFs` is additive; remove it and the `fs.search` hook (the hook is optional) to revert.

## 12. Open Questions
- Q1: Build the tree from a stored manifest doc or derive from chunk metadata? — tradeoff: manifest = fast/explicit but needs an ingestion step; derivation = zero-setup but a metadata scan. **Proposal:** support both; prefer manifest when present (`manifestKey`), fall back to derivation. Ship derivation first (C1), manifest in C6.
- Q2: grep fine pass — regex or BM25? — tradeoff: regex = exact/grep-like; BM25 = ranked relevance. **Proposal:** default to regex (grep semantics: the user asked for grep); expose BM25 as an opt-in for ranked search. Reuse the existing `BM25Index`.
- Q3: Should `KnowledgeFs` be in `@kuralle-agents/rag` or a new `@kuralle-agents/rag-fs`? — tradeoff: cohesion with the store vs package bloat. **Proposal:** in `@kuralle-agents/rag` under `src/fs/` (it depends on rag internals; a separate package adds a publish unit for no benefit).
