# Kuralle Filesystem Primitives — Plan

## 1. Thesis

Five studied systems converge on one fact: **the unit of reuse is a narrow ~15-method async `FileSystem` interface, and everything else (model tools, git, skills, RAG) composes *over* it.** The interface is identical on Node and Cloudflare Workers; only the *backend* swaps. Kuralle has no fs/workspace primitive in `AgentConfig` today (`packages/kuralle-core/src/types/agentConfig.ts:16-51`) — there is `tools`/`effectTools`/`globalTools`/`knowledge`/`memory` but no path-addressed surface. The right move is **not** to invent a new abstraction: copy cloudflare-agents' `FileSystem` interface + `InMemoryFs` (the only studied impl that is *already* zero-Node-deps and Workers-clean), expose it to the model as a single durable `fs` effect tool speaking `ls/cat/grep/find`, and back the customer-support use case with a read-only adapter over the RAG store Kuralle already ships. Hare is the contrast case that tells us what *not* to do: wiring storage as N narrow CRUD tools with security-by-string-prefix is the cheaper floor but gives up the one verb-set and the durability Kuralle already has.

### TL;DR proposed changes

- New package **`@kuralle-agents/fs`** holding the portable `FileSystem` interface + `InMemoryFs` (copied from cloudflare-agents), `path-utils`, `encoding`.
- One **`createFsTool({ fs })` → durable effect tool** in that package (uses `defineTool`, `packages/kuralle-core/src/tools/effect/defineTool.ts:13`) exposing `ls/cat/grep/find/read/write/edit` as a single model-visible tool whose `execute` returns structured data (honoring Kuralle's "tools return data only" rule).
- One new optional `AgentConfig` field: **`workspace?: FileSystem`** (`agentConfig.ts:51`). When set, the runtime auto-registers `createFsTool` into the agent's tool surface. No new flow/route concepts.
- Backends: `InMemoryFs` (default, both runtimes); **`KnowledgeFs`** (read-only adapter over `@kuralle-agents/rag` `VectorStoreCore`, both runtimes) for the support-agent KB; a durable SQL-backed `WorkspaceFs` is a deferred follow-up (DO SqlStorage on CF / `*-store` on Node).
- An **out-of-band `fs` handle on the run/tool context** (`ToolContext`, `run-context.ts:102`) so flows can stage files the model must not see — copying Flue's dual-surface idea.

---

## 2. Per-system breakdown (file-cited)

### Flue — one `SessionEnv` substrate, dual FS surface, just-bash default
- The single internal abstraction is `SessionEnv` — `exec` + 8 FS methods + `cwd`/`resolvePath`; the comment is explicit that *all* sandbox modes collapse to it "no mode-specific branching needed in core logic" (`research/flue/packages/runtime/src/types.ts:259-311`).
- **Dual surface, the load-bearing idea:** the model gets typed `read/write/edit/bash/grep/glob` tools (`agent.ts:41-52`); *code* gets `FlueFs` (= `SessionEnv` minus exec/cwd) on `harness.fs`/`session.fs`, explicitly "out-of-band — they don't appear in the conversation transcript" for "plumbing the model shouldn't see" (`types.ts:313-329`). Adapter is 8 forwarders (`sandbox.ts:12-23`).
- `grep`/`glob` are **shelled out** to `grep -rn`/`find -name` through `env.exec` — search is bash, not a native FS index (`agent.ts:388-478`).
- Default env is **identical on both runtimes**: in-memory `just-bash` (`Bash`+`InMemoryFs`); only the real remote-container connector `cfSandboxToSessionEnv` is CF-specific (`cloudflare/cf-sandbox.ts:7-125`). Core never imports just-bash — it duck-types a structural `BashLike` (`types.ts:933-953`).
- Cleverest cross-cutting piece: `timeout` (seconds) → `AbortSignal.timeout()` merged with caller signal via `AbortSignal.any()` (`sandbox.ts:77-82`); the bash *tool* turns a timeout-only abort into a recoverable exit-124 result so the model retries, but rethrows on host abort (`agent.ts:218-273`).
- Caution: Flue's `defineTool.execute` returns a plain **string** (`types.ts:243`) — conflicts with Kuralle's structured-data contract. Borrow shapes/abort plumbing, not the string return.

### Hare — the contrast: storage IS the binding, surfaced as N CRUD tools (no VFS)
- **No virtual filesystem exists.** `grep vfs|virtual file|filesystem|mount` over `packages/tools/src` returns zero VFS hits. Persistence = discrete CRUD tools wired 1:1 to CF primitives: `kv_*` (`research/hare/packages/tools/src/kv.ts`), `r2_*` (`r2.ts`), `sql_*` (`sql.ts`), `store_memory`/`recall_memory` (`memory.ts`).
- The only "path" abstraction is workspace key-prefixing: `scopedKey`/`scopedPath` prefix `ws/${workspaceId}/` and reject `..`/leading `/` (`kv.ts:62-76`, `r2.ts:82-104`) — tenant isolation by string, validated in-tool.
- A *real* fs exists only inside the opt-in Sandbox container (`SandboxInstance` = `writeFile/readFile/exec`, `sandbox.ts:68-75`), gated behind rate-limit + denylist + audit; bash hard-disabled (`sandbox.ts:282-291`).
- SQL guardrails are security-by-regex and the code admits the fragility — can't parse CTEs/subqueries, `workspace`-substring required on every statement (`sql.ts:52-73`, `:145`).
- Tools are plain async fns returning `ToolResult{success,data?,error?}` (`types.ts:30-34`) — **no exactly-once durability**; a retry re-runs `r2_put`/`sql_execute`.
- **Lesson for Kuralle:** wiring CF primitives directly as typed tools is the right *floor* for blob/kv/row storage, and a real filesystem belongs only inside a locked-down container — never as the portable substrate. A portable VFS earns its place only if it (a) unifies the verb-set behind one path handle and (b) carries durability + structural scoping that string-prefixing can't.

### cloudflare-agents `shell` — the keystone: a narrow `FileSystem`, two backends, fat layers compose over it
- The reusable primitive is the `FileSystem` interface — ~20 async methods, throws `ENOENT` (never null), `glob` returns sorted absolute paths (`research/cloudflare-agents-sdk/packages/shell/src/fs/interface.ts:52-74`, contracts at `:46-50`).
- Two impls behind it: **`InMemoryFs`** (rooted `Map<string,VNode>` tree, symlinks, lazy files; pure JS + `TextEncoder`/`atob`/`btoa`, **zero `node:`/Web-only deps → Node+Bun+Workers+browser**, `fs/in-memory-fs.ts:116`) and **`WorkspaceFileSystem`** (adapter over a CF-specific durable `Workspace`, `workspace.ts:26`).
- The durable `Workspace` is doubly abstracted: a `SqlBackend`/`SqlSource` seam auto-detecting DO `SqlStorage` / `D1Database` / raw adapter (`filesystem.ts:37-92`) + per-file `'inline' | 'r2'` storage with a size threshold (`filesystem.ts:184`, `:333-390`). So the *same* durable store runs on DO storage, D1, or your own SQL.
- **Narrow primitive, fat composition:** the 47-method `StateBackend` (`backend.ts:275-368`) and git both build *over* the narrow `FileSystem` without knowing the backend. Git is pure-composition: `createGitFs(fs)` wraps any `FileSystem` into isomorphic-git's shape (`git/fs-adapter.ts:85`), runs identically in-memory or durable, Workers-portable via `isomorphic-git/http/web` (`git/index.ts:18-19`).
- Only `node:` dep in the whole stack is `node:diagnostics_channel` for observability (`workspace.ts`), guardable via the plain `onChange` callback.
- This is the design to copy: **`fs/interface.ts`, `path-utils.ts`, `encoding.ts`, `in-memory-fs.ts` are copyable verbatim, fully portable.**

### Mastra — composite/mount routing + agent-correctness primitives + skills-as-records
- `WorkspaceFilesystem` — one ~15-method async interface with UI metadata + `getInstructions?()` (self-describing → injected into tool descriptions) (`research/mastra/packages/core/src/workspace/filesystem/filesystem.ts:156-317`). `LocalFilesystem` (`node:fs/promises`) is the Node-only impl.
- Standout: **`CompositeFilesystem` is itself a `WorkspaceFilesystem`** and routes by longest-prefix mount (`composite-filesystem.ts:191-211`); `readdir('/')` synthesizes virtual entries for mount points (`:213-247`); cross-mount copy/move falls out as read-from-src/write-to-dest (`:333-366`); composite is read-only iff every mount is (`:105`).
- **Agent-correctness primitives (tiny, dependency-free):** `FileReadTracker` enforces read-before-write, returning an LLM-readable `reason` string ("You must read a file before writing to it" / "re-read to get latest") (`file-read-tracker.ts:25-64`); `FileWriteLock` serializes per-path writes via a promise queue with 30s timeout (`file-write-lock.ts:20-94`); `WriteOptions.expectedMtime` gives optimistic concurrency, failing with `StaleFileError` (`filesystem.ts:80-85`).
- Containment is Node-specific + security-critical: `contained:true` confines to `basePath`+`allowedPaths`, with an async realpath check on every op to defeat symlink escapes (`local-filesystem.ts:65,250,347`).
- **Skills are NOT folders of files** — a skill = a thin record (`StorageSkillType`: id/status `draft|published|archived`/`activeVersionId`/visibility, `storage/types.ts:1964`) + immutable version snapshots whose `instructions` field is the `SKILL.md` body and whose `scripts/assets/references` are **path lists** into the workspace FS, not inline content (`types.ts:1933-1958`). `update` diffs tracked fields → new version only on change (`storage/domains/skills/filesystem.ts:144-163`). Definition (publishable, versioned, multi-tenant) is decoupled from execution (sandboxed FS).

### ChromaFs (Mintlify) — read-only KB exploration, why `grep/cat/ls/find` is the verb-set
- Thesis: "`grep`, `cat`, `ls`, and `find` are all an agent needs. If each doc page is a file and each section is a directory, the agent can search for exact strings, read full pages, and traverse the structure on its own" — beats top-K RAG when the answer spans pages or needs exact syntax (`research/_sources/web/mintlify-chromafs.md:7,9`).
- Five primitives: (1) pluggable `IFileSystem` seam (just-bash owns parse/pipe/flags, backend swaps, `:28`); (2) **path-tree manifest** `__path_tree__` (gzipped JSON, decompressed into `Set<path>` + `Map<dir,children[]>` so `ls/find` are zero-network; structure eager, content lazy via `cat`, `:39-50`); (3) **RBAC-by-tree-pruning** — each entry carries `{isPublic,groups}`, pruned by session token *before* the tree is built so the agent can't even reference a hidden file (`:45,54`); (4) **read-only `EROFS` → statelessness** (no mutation → no cleanup → safe multi-tenant, `:62`); (5) **two-stage grep** — DB `$contains`/`$regex` coarse-filters candidate files, in-memory just-bash runs the real flag semantics fine (`:64-69`). Plus chunk reassembly (`cat slug` = fetch chunks, sort by `chunk_index`, join, `:58`) and lazy file pointers (`:60`).
- Read-only is the *adapter's* policy, not the interface's — the interface documents no EROFS rule.

---

## 3. Deconstruction to primitives

The irreducible primitive across all five is **a narrow async path-addressed `FileSystem`** with a small fixed verb-set. Everything productive (model tools, git, skills, RBAC, durability) is *composition over it*. The differences are: (a) what the verb-set is, (b) how search is done, (c) how the model sees it, (d) what backends exist, (e) write policy.

| Dimension | Flue | Hare | cloudflare-agents | Mastra | ChromaFs |
|---|---|---|---|---|---|
| Core primitive | `SessionEnv` (8 fs + exec) `types.ts:265` | **none** — CRUD tools per binding `types.ts:16` | `FileSystem` ~20 methods `interface.ts:52` | `WorkspaceFilesystem` ~15 `filesystem.ts:156` | `IFileSystem` (just-bash) `:28` |
| Default backend | in-mem just-bash (both rt) `cf-sandbox` only CF | CF bindings only | **`InMemoryFs` (both rt)** `in-memory-fs.ts:116` | `LocalFilesystem` (Node) | DB-backed manifest+chunks |
| Durable backend | remote sandbox connector | KV/R2/D1 (CF) | `Workspace` SqlBackend+R2 `filesystem.ts:37` | versioned storage domains | vector/doc DB |
| Search | `grep`/`find` shelled to exec `agent.ts:388` | none (vector recall) | `glob` (FS) | provider | **two-stage DB→in-mem grep** `:64` |
| Model surface | 6 typed tools (transcript) | N CRUD tools | codemode `state.*` tools | tools w/ `getInstructions()` | just-bash `grep/cat/ls/find` |
| Out-of-band code surface | **`FlueFs` (invisible)** `types.ts:313` | n/a | `FileSystem` directly | direct | n/a |
| Write policy | rw | rw (no durability) | rw | rw + read-track + write-lock | **read-only `EROFS`** `:62` |
| Multi-tenant | sandbox id | key-prefix (string) `kv.ts:64` | namespace table | authorId/visibility records | **tree-pruning by groups** `:54` |
| Portability | core portable; connectors split | tool machinery only | **interface+InMemoryFs verbatim** | interface portable; Local=Node | runtime-agnostic (cache only rt-specific) |

**The minimal interface Kuralle needs** (subset that serves `ls/cat/grep/find` + write/edit), exactly cloudflare-agents' shape:

```ts
interface FileSystem {
  readFile(path): Promise<string>; readFileBytes(path): Promise<Uint8Array>;
  writeFile(path, content): Promise<void>; appendFile(path, content): Promise<void>;
  exists(path): Promise<boolean>;
  stat(path): Promise<FsStat>;                 // throws ENOENT
  mkdir(path, opts?): Promise<void>;
  readdir(path): Promise<string[]>; readdirWithFileTypes(path): Promise<FileSystemDirent[]>;
  rm(path, opts?): Promise<void>;
  resolvePath(base, path): string;             // sync
  glob(pattern): Promise<string[]>;            // sorted absolute
}
```
(`research/cloudflare-agents-sdk/packages/shell/src/fs/interface.ts:52-74`)

---

## 4. Proposed Kuralle design

**Decision: copy cloudflare-agents' `FileSystem` + `InMemoryFs` verbatim** (it is the only studied impl already proven zero-`node:`-deps and Workers/browser-clean, `in-memory-fs.ts` + `path-utils.ts` "safe for browser bundles and Workers"). Borrow Flue's dual-surface idea and Mastra's read-tracker/write-lock as opt-in tool-layer policy. Do **not** copy Mastra's containment (Node-specific) into the portable core; do **not** copy Hare's N-CRUD-tools floor (we want one path verb-set + the durability we already have).

### 4.1 New package `@kuralle-agents/fs`

```
packages/kuralle-fs/src/
  interface.ts      # FileSystem, FsStat, FileSystemDirent, MkdirOptions, RmOptions  (copied)
  path-utils.ts     # pure normalize/join/dirname/basename (copied — no node:path)
  encoding.ts       # toBuffer/fromBuffer/getEncoding (copied)
  in-memory-fs.ts   # InMemoryFs (copied) — default backend, both runtimes
  tool.ts           # createFsTool({ fs }) -> AnyTool  (Kuralle-specific glue)
  index.ts
```
Portable tier (Node + CF, no `node:` imports): all of the above. This package depends only on `ai`/`zod`/`@kuralle-agents/core` types — never on `node:fs`/`child_process`.

### 4.2 The one model tool — `createFsTool`

A single durable effect tool, built with the existing `defineTool` (`packages/kuralle-core/src/tools/effect/defineTool.ts:13`). One tool, not six — the model gets `ls/cat/grep/find/read/write/edit` as named ops. `execute` returns **structured data** (not a string), honoring Kuralle's contract; the search ops are implemented over the narrow `FileSystem` (`glob` + in-memory line scan — no shelling, so it works on Workers where Flue's `grep -rn` exec cannot):

```ts
// packages/kuralle-fs/src/tool.ts
import { defineTool } from '@kuralle-agents/core';
import { z } from 'zod';
import type { FileSystem } from './interface.js';

export function createFsTool({ fs, readOnly = false }: { fs: FileSystem; readOnly?: boolean }) {
  return defineTool({
    name: 'fs',
    description: 'Explore and read the agent workspace: ls/cat/grep/find (+ read/write/edit).',
    input: z.object({
      op: z.enum(['ls', 'cat', 'grep', 'find', 'read', 'write', 'edit']),
      path: z.string().optional(),
      pattern: z.string().optional(),
      content: z.string().optional(),
      // edit: exact unique-match replace, like Claude Code / Flue agent.ts:159
      oldString: z.string().optional(),
      newString: z.string().optional(),
    }),
    timeoutMs: 30_000,
    execute: async (args, ctx) => {
      switch (args.op) {
        case 'ls':   return { entries: await fs.readdirWithFileTypes(args.path ?? '/') };
        case 'cat':
        case 'read': return { content: await fs.readFile(args.path!) };       // throws ENOENT -> model recovers
        case 'find': return { paths: await fs.glob(args.pattern!) };
        case 'grep': return { matches: await grepOverFs(fs, args.pattern!) }; // glob + in-mem line scan
        // write/edit blocked when readOnly -> return {error:'EROFS'} (ChromaFs policy, data-only)
        ...
      }
    },
  });
}
```
- Returns data only; the model recovers from `ENOENT`/`EROFS` as tool errors — same discipline as Mastra's read-tracker `reason` strings (`file-read-tracker.ts:64`).
- `edit` uses the unique-match replace contract (`research/flue/.../agent.ts:159-203`).
- `timeoutMs` already exists on `defineTool` (`defineTool.ts:29`); the Flue timeout↔AbortSignal normalization (`sandbox.ts:77-82`) is a follow-up if/when a remote backend lands — irrelevant for `InMemoryFs`/`KnowledgeFs` (synchronous-ish, abortable via `ctx`).

### 4.3 `AgentConfig` change — exactly one field

Add `workspace?: FileSystem` to `AgentConfig` (`packages/kuralle-core/src/types/agentConfig.ts:51`):

```ts
  /** Path-addressed workspace exposed to the model as a single `fs` tool
   *  (ls/cat/grep/find/read/write/edit). Portable: InMemoryFs (default) on
   *  both runtimes, KnowledgeFs for a read-only KB, durable backend on CF/Node. */
  workspace?: FileSystem;
```
When `workspace` is set, the runtime registers `createFsTool({ fs: config.workspace })` into the agent's effect-tool surface (the same path that already merges `effectTools`/`globalTools`). No new flow/route/routing concept — a flow node can reach the fs tool exactly like any other effect tool. This mirrors how `knowledge`/`memory` are single optional fields, not subsystems.

**Reject** a `skills`/`scripts`/`bash` field for now (YAGNI for the support use case). Skills, if added later, follow Mastra: a versioned record in a `*-store` whose `scripts`/`assets` are path lists *into* `workspace` — a separate change, not this one.

### 4.4 Out-of-band fs handle (Flue's dual surface)

Expose the same `FileSystem` (the configured `workspace`) on `ToolContext`/`RunContext` (`packages/kuralle-core/src/types/run-context.ts:102`) as `ctx.fs`, so a flow's `action` node can stage/read files the model never sees in the transcript — Flue's `FlueFs` idea (`types.ts:313-329`). This is the *same* object, not a second backend; "out-of-band" = "not turned into a model tool call," which is automatic since flow code calls `ctx.fs.*` directly.

### 4.5 Node vs Cloudflare portability strategy

| Backend | Node/Bun (`@kuralle-agents/hono-server`) | Cloudflare (`@kuralle-agents/cf-agent`) |
|---|---|---|
| `InMemoryFs` (default) | ✅ identical | ✅ identical (zero `node:` deps) |
| `KnowledgeFs` (read-only KB) | ✅ over any `VectorStoreCore` | ✅ over Vectorize (`@kuralle-agents/vectorize-store`) |
| Durable `WorkspaceFs` (deferred) | SqlBackend over `@kuralle-agents/postgres-store`/SQLite | SqlBackend over DO `SqlStorage` (+ R2 spill) |

The seam is the `FileSystem` interface; the runtime never branches on platform — exactly how Kuralle already abstracts `SessionStore` across Memory/Redis/Postgres, and how cloudflare-agents' `SqlBackend` auto-detects its store (`filesystem.ts:37-92`). The durable backend copies cloudflare-agents' `SqlBackend`/`SqlSource` pattern with the `node:diagnostics_channel` line dropped in favor of the plain `onChange` callback.

---

## 5. Use case walkthrough — customer-support agent over a local KB

A support agent that explores a product KB with `ls/cat/grep/find` instead of one-shot top-K RAG (the ChromaFs thesis, `mintlify-chromafs.md:7`). Two developer-facing shapes:

### 5.1 Bundled docs as an in-memory workspace (simplest, both runtimes)

```ts
import { defineAgent } from '@kuralle-agents/core';
import { InMemoryFs } from '@kuralle-agents/fs';

const kb = new InMemoryFs({
  '/billing/refunds.md': '# Refunds\nRefunds process in 5–7 days...',
  '/errors/ENOTFOUND.md': '# ENOTFOUND\nCheck the API base URL...',
  '/getting-started/index.md': '...',
});

export const supportAgent = defineAgent({
  id: 'support',
  model: openai('gpt-4.1-mini'),
  instructions:
    'You answer from the knowledge base. Use the `fs` tool: `find`/`grep` to locate the right page, `cat` to read it. Quote exact text.',
  workspace: kb,        // <- the one new field; auto-registers the `fs` tool
});
```
The model self-drives: `fs{op:'grep',pattern:'ENOTFOUND'}` → `fs{op:'cat',path:'/errors/ENOTFOUND.md'}` → grounded answer. Durability/exactly-once comes free from the effect-tool path; works unchanged on Node and Workers because `InMemoryFs` is dep-free.

### 5.2 Large/multi-tenant KB over the existing RAG store (`KnowledgeFs`)

For a real KB with RBAC, back the same `FileSystem` interface with a read-only adapter over `@kuralle-agents/rag` — the verb-set is identical, the model code doesn't change. This reuses what Kuralle already ships:

```ts
import { KnowledgeFs } from '@kuralle-agents/rag/fs';   // read-only adapter

const kb = await KnowledgeFs.open(vectorStore, 'product-docs', {
  groups: session.user.tier,    // RBAC: prune tree before the agent sees it
});
export const supportAgent = defineAgent({ id: 'support', model, workspace: kb });
```
`KnowledgeFs` (Workers + Node, zero extra deps) maps: a "file" = a source doc (chunks sharing a slug); `cat` = chunk reassembly sorted by `chunk_index`; `grep` = two-stage (coarse `store.query(filter)` candidate-narrowing → in-mem `BM25Index` fine pass); RBAC = tree-pruning via `matchFilter`. Grounded reusable rag primitives: `VectorStoreCore.query` + `VectorQueryResult` (`packages/kuralle-rag/src/types.ts:274,184`), `VectorFilter` MongoDB-style `$in/$and` (`types.ts:240`), `BM25Index` zero-dep Workers-safe (`packages/kuralle-rag/src/index.ts:89`), `matchFilter` portable predicate (`index.ts:68`). Write ops return `{error:'EROFS'}` (ChromaFs read-only policy, `mintlify-chromafs.md:62`).

### 5.3 Flow staging the model shouldn't see (out-of-band)

```ts
// inside a flow action node — uses ctx.fs, never appears as a model tool call
action(async (ctx) => {
  await ctx.fs.writeFile('/scratch/case.json', JSON.stringify(caseData));  // staged, invisible
});
```
Same `FileSystem` object, out-of-band by construction (Flue's `FlueFs`, `types.ts:313-329`).

---

## 6. Open questions

1. **RAG `query` requires a `queryVector`** (`packages/kuralle-rag/src/types.ts:206`), but `cat`/exact-`grep`/manifest want metadata-only lookups. Reserve a constant zero vector + rely on `filter`, or add a small `getByFilter(indexName, filter)` to `VectorStoreCore`? The latter is the cleaner long-term primitive (ChromaFs's speed story is "DB metadata query, not similarity scan", `mintlify-chromafs.md:34`) but touches every store adapter.
2. **Where does `createFsTool` registration live** — does the runtime merge `workspace`→fs-tool into `effectTools` at agent-resolution time, or is it a `globalTools` entry (so it's model-visible in every speaking node, ADR 0001)? For a support agent, `globalTools` semantics (`agentConfig.ts:33`) are likely what's wanted; confirm against flow-gating rules.
3. **`grep` cost on `InMemoryFs`** — naive glob + read-every-file line scan is O(corpus). Fine for a bundled KB; for large `KnowledgeFs` the two-stage DB-coarse pass is required. Should the portable `grepOverFs` helper expose a pluggable coarse-filter hook so `KnowledgeFs` can inject the DB pass?
4. **Read-tracker/write-lock** (Mastra `file-read-tracker.ts`, `file-write-lock.ts`) — adopt now for the write/edit ops, or defer until a read-write workspace use case exists? Cheap and portable, but the support use case is read-only.
5. **Durable `WorkspaceFs` backend** — confirm DO `SqlStorage` (CF) and a Node SQL adapter both satisfy cloudflare-agents' `SqlBackend` (`filesystem.ts:37-43`) before committing to that pattern over `*-store`.
6. **just-bash vs. a hand-rolled verb-set** — ChromaFs/Flue lean on just-bash for real pipe/flag semantics; the proposal above hand-implements `ls/cat/grep/find` over the narrow `FileSystem` to avoid a dep and stay Workers-clean. Is full bash-flag fidelity ever needed for a support agent? (Assumption: no.)

## 7. Risks / non-goals

- **Non-goal: a sandbox/exec primitive.** No `bash`/`exec`/container substrate in core (Hare proves a real fs belongs only in a locked-down container, `research/hare/.../sandbox.ts:282-291`; Flue's exec is for remote sandboxes Kuralle doesn't have). The `fs` tool is data-plane only.
- **Non-goal: `skills`/`scripts` AgentConfig fields in this change.** Skills follow Mastra's versioned-record model later (`research/mastra/.../storage/domains/skills/filesystem.ts:144`); folding them in now is speculative.
- **Risk: containment.** Any *writable* model-facing FS needs containment; Mastra's realpath-per-op check is Node-specific (`local-filesystem.ts:347`). `InMemoryFs` and read-only `KnowledgeFs` sidestep this (no host FS, no symlinks); a durable writable backend must add its own path-confinement (string-level for SQL-keyed, no `..`/leading-`/`, à la Hare `kv.ts:64`).
- **Risk: tool contract drift.** Flue's `execute` returns a string (`types.ts:243`); copying its tool shapes naively would violate Kuralle's "tools return data only" rule (`CLAUDE.md`). The proposal explicitly returns structured data.
- **Risk: RAG store coupling.** `KnowledgeFs` belongs in `@kuralle-agents/rag` (not `@kuralle-agents/fs`) so core/fs stays free of vector-store deps; only the `FileSystem` interface is shared upward.
- **Risk: stale-dist gotcha.** New `@kuralle-agents/fs` package + `agentConfig.ts` change means rebuilding core before any consumer/example picks up the `workspace` field (per repo CLAUDE.md "stale dist" discipline).
