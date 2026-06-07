# RFC: `@kuralle-agents/fs` — portable filesystem primitive

**Category:** New Feature
**Author:** kuralle-harness program
**Date:** 2026-06-07
**Status:** Draft
**Reviewers:** (program)
**Related:** `research/filesystem-primitives-plan.md`, `research/fs-skills-harness-synthesis.md`, `rfcs/kuralle-harness/rfc-01-tool-model-cleanup.md`
**Depends on:** RFC-01 (the durable `tools` field + `wrapAiSdkTool` + journal).

---

## 1. Problem Statement

Kuralle agents cannot explore or manipulate files. The research shows the irreducible agent interface is a **filesystem** (`ls/cat/grep/find/read/write/edit`) over a narrow async `FileSystem` interface where only the backend swaps (`research/filesystem-primitives-plan.md`). Kuralle has no such primitive — and a built-but-orphaned filesystem-as-memory store (`FilePersistentMemoryStore`, `packages/kuralle-core/src/memory/blocks/FilePersistentMemoryStore.ts:35`, exported `index.ts:131` but never consumed by `runtime/`).

Success: a new `@kuralle-agents/fs` package exporting a portable `FileSystem` interface + `InMemoryFs` (zero `node:*`), a single durable fs tool exposing `ls/cat/grep/find/read/write/edit`, and one `AgentConfig.workspace?: FileSystem` field that auto-registers the tool. Runs byte-identically on Node and Cloudflare Workers.

## 2. Background

Cross-system study (`research/filesystem-primitives-plan.md`):
- **cloudflare-agents** `packages/shell/src/fs/interface.ts:52` defines a clean ~15-method `FileSystem` (`readFile`, `readFileBytes`, `writeFile`, `writeFileBytes`, `appendFile`, `exists`, `stat`, `readdir`, `mkdir`, `rm`, `cp`, `rename`, ...). `path-utils.ts:4` is explicit: "No node:fs or node:path dependencies — safe for browser bundles and Workers." It ships an `InMemoryFs` (`in-memory-fs.ts`) and a git adapter over the same interface. This is a *Cloudflare* SDK, so Workers-portability is proven, not hoped — **the design to copy verbatim**.
- **Mastra** `packages/core/src/workspace/filesystem/*` has a richer interface with composite/mount + read-tracker/write-lock — more than needed now.
- **Flue** wires `just-bash` (`Bash`, `InMemoryFs`) for `grep/cat/ls/find` over a pluggable `IFileSystem`.
- **Hare** is the anti-pattern: N CRUD tools over CF storage, no portable VFS, no durability.

Decision (from `research/fs-skills-harness-synthesis.md`): copy cloudflare-agents' interface; expose ONE durable tool (not N CRUD tools); `Shell`/exec is a non-goal (deferred Node-only RFC). Reconcile, don't duplicate, the orphaned `FilePersistentMemoryStore`.

## 3. Strict Requirements

- REQ-1: New package `@kuralle-agents/fs` (`packages/kuralle-fs/`) exporting `FileSystem` (interface), `InMemoryFs` (impl), `path-utils`, `encoding`, copied/adapted from cloudflare-agents `packages/shell/src/fs/*`. Zero `node:*` imports in the interface and `InMemoryFs`.
- REQ-2: A factory `createFsTool({ fs, readOnly?, timeoutMs? }): AnyTool` built with `defineTool` (`packages/kuralle-core/src/tools/effect/defineTool.ts:13`) exposing named ops `ls | cat | grep | find | read | write | edit`, returning **structured data** (not raw strings), per Kuralle's "tools return data only" rule.
- REQ-3: `cat`/`grep`/`find` errors surface as model-recoverable tool errors: `ENOENT` (missing path), `EROFS` (write on read-only fs), `EISDIR`/`ENOTDIR` as appropriate.
- REQ-4: Add `AgentConfig.workspace?: FileSystem` (`packages/kuralle-core/src/types/agentConfig.ts`). When set, the runtime auto-registers `createFsTool({ fs: workspace })` into the durable tool surface (same merge path as `tools`/`globalTools`, `runtime/Runtime.ts:118-125`).
- REQ-5: Expose the same `FileSystem` on `ToolContext`/`RunContext` as `ctx.fs` (`packages/kuralle-core/src/types/run-context.ts`) so flow `action` nodes can stage files out-of-band (invisible to the transcript).
- REQ-6: `@kuralle-agents/fs` is Workers-clean: a vitest-pool-workers test runs `InMemoryFs` + `createFsTool` round-trip inside `workerd`. A Node example does the same.
- REQ-7: Reconcile the orphaned `FilePersistentMemoryStore` — either (a) re-express it as a `FileSystem`-backed store, or (b) document its relationship to `workspace`. No second parallel store invented.
- REQ-8: `bun run typecheck:all` + `bun run test` green; package publishes-dry-run clean (no `.map`, no `node:*` in the portable entrypoints).

## 4. Interface Specification

### 4.1 `FileSystem` (interface, copied)
- **Location:** `packages/kuralle-fs/src/interface.ts`
- **Signature (excerpt):**
  `readFile(path): Promise<string>` · `readFileBytes(path): Promise<Uint8Array>` · `writeFile(path, content): Promise<void>` · `appendFile(path, content): Promise<void>` · `exists(path): Promise<boolean>` · `stat(path): Promise<FsStat>` · `readdir(path): Promise<FileSystemDirent[]>` · `mkdir(path, opts?): Promise<void>` · `rm(path, opts?): Promise<void>` · `cp(src, dst, opts?): Promise<void>` · `rename(src, dst): Promise<void>`
- **Behavior:** narrow async POSIX-ish surface; backend-independent. Match cloudflare-agents `interface.ts:52` signatures exactly to preserve interop.
- **Error cases:** throw typed errors (`code: 'ENOENT'|'EROFS'|...`).

### 4.2 `InMemoryFs` (impl, copied)
- **Location:** `packages/kuralle-fs/src/in-memory-fs.ts`
- **Signature:** `new InMemoryFs(seed?: Record<string,string|Uint8Array>)`
- **Behavior:** in-memory tree; zero `node:*`; constructor optionally seeds bundled docs.

### 4.3 `createFsTool` (new)
- **Location:** `packages/kuralle-fs/src/tool.ts`
- **Signature:** `createFsTool(opts: { fs: FileSystem; readOnly?: boolean; timeoutMs?: number }): AnyTool`
- **Behavior:** one `defineTool` named `workspace` whose `input` is a discriminated union `{ op: 'ls'|'cat'|'grep'|'find'|'read'|'write'|'edit', ...args }`; returns `{ op, ok, data }` structured results. `grep` uses a two-stage approach when the fs provides a coarse filter (see RFC-03), else in-memory scan. `write`/`edit` throw `EROFS` when `readOnly`.
- **Error cases:** invalid op → tool error; missing path → `ENOENT`; write on read-only → `EROFS`.

### 4.4 `AgentConfig.workspace` + `RunContext.fs` (modified)
- **Location:** `packages/kuralle-core/src/types/agentConfig.ts`, `types/run-context.ts`
- **Signature:** `workspace?: FileSystem` on `AgentConfig`; `fs?: FileSystem` on `RunContext`/`ToolContext`.
- **Behavior:** presence of `workspace` → auto-register `createFsTool` + thread `fs` onto `ctx`.

## 5. Architecture and System Dependencies

### 5.1 Structural changes
New package `packages/kuralle-fs/` (`src/{interface,in-memory-fs,path-utils,encoding,tool,index}.ts`). Modify `kuralle-core`: `agentConfig.ts` (+`workspace`), `run-context.ts` (+`fs`), `runtime/Runtime.ts` (auto-register + thread `ctx.fs`), `runtime/ctx.ts` (set `fs`). The `FileSystem` type is imported into core type-only (no runtime dep core→fs; the fs tool factory lives in the fs package).

### 5.2 Dependency direction
`@kuralle-agents/fs` depends on `@kuralle-agents/core` (for `defineTool`/`AnyTool`). Core declares the `FileSystem` *interface* type (to avoid a core→fs runtime dependency for the `workspace` field) — OR the field is typed via a structural import. **Proposal:** declare `FileSystem` interface in `kuralle-core/src/types/filesystem.ts` and re-export from `@kuralle-agents/fs`, keeping the graph one-directional (avoids the stale-dist trap, CLAUDE.md gotcha).

### 5.3 Data/schema
None. Bundled docs are seeded into `InMemoryFs` by the developer.

### 5.4 Network/performance
`InMemoryFs` is sync-fast. `grep` over many files is in-memory; large KBs are RFC-03's two-stage concern.

## 6. Pseudocode

```
createFsTool({fs, readOnly, timeoutMs}):
  return defineTool({
    name: "workspace",
    description: "Explore/edit the workspace: ls, cat, grep, find, read, write, edit",
    input: union over op,
    timeoutMs,
    execute(args, ctx):
      switch args.op:
        ls    -> fs.readdir(args.path)               -> {entries}
        cat/read -> fs.readFile(args.path)           -> {content}
        find  -> walk(fs, args.root, args.glob)      -> {paths}
        grep  -> coarse = fs.search?(args.pattern) ?? all
                 hits = inMemoryRegex(coarse, args.pattern, flags)  -> {hits}
        write -> if readOnly throw EROFS; fs.writeFile(...)         -> {ok}
        edit  -> if readOnly throw EROFS; read, apply patch, write  -> {ok}
  })

# Runtime wiring
IF agent.workspace:
  ctx.fs = agent.workspace
  registry["workspace"] = createFsTool({ fs: agent.workspace })
```

## 7. Code Blueprint

```ts
// packages/kuralle-fs/src/tool.ts
import { defineTool } from '@kuralle-agents/core';
import { z } from 'zod';
import type { FileSystem } from './interface.js';

export function createFsTool(opts: { fs: FileSystem; readOnly?: boolean; timeoutMs?: number }) {
  const { fs, readOnly = false, timeoutMs } = opts;
  return defineTool({
    name: 'workspace',
    description: 'Explore and edit the agent workspace. Ops: ls, cat, grep, find, read, write, edit.',
    timeoutMs,
    input: z.discriminatedUnion('op', [
      z.object({ op: z.literal('ls'), path: z.string().default('/') }),
      z.object({ op: z.literal('cat'), path: z.string() }),
      z.object({ op: z.literal('grep'), pattern: z.string(), path: z.string().default('/'), flags: z.string().optional() }),
      z.object({ op: z.literal('find'), root: z.string().default('/'), glob: z.string() }),
      z.object({ op: z.literal('read'), path: z.string() }),
      z.object({ op: z.literal('write'), path: z.string(), content: z.string() }),
      z.object({ op: z.literal('edit'), path: z.string(), find: z.string(), replace: z.string() }),
    ]),
    async execute(a) {
      switch (a.op) {
        case 'ls':   return { op: a.op, ok: true, entries: await fs.readdir(a.path) };
        case 'cat':
        case 'read': return { op: a.op, ok: true, content: await fs.readFile(a.path) };
        // find/grep/write/edit ... (write/edit throw EROFS when readOnly)
      }
    },
  });
}
```

## 8. Incremental Task Breakdown

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C1 | Scaffold `@kuralle-agents/fs` package (package.json, tsconfig, build) per monorepo conventions | `packages/kuralle-fs/{package.json,tsconfig.json,src/index.ts}` | REQ-1 | `bun run build` builds the package; no `.map` shipped |
| C2 | Copy `FileSystem` interface + `path-utils` + `encoding` (zero `node:*`); declare interface in `kuralle-core/src/types/filesystem.ts`, re-export from fs pkg | `packages/kuralle-fs/src/{interface,path-utils,encoding}.ts`, `kuralle-core/src/types/filesystem.ts` | REQ-1, §5.2 | `rg "node:" packages/kuralle-fs/src/{interface,in-memory-fs,path-utils}.ts` empty |
| C3 | Copy `InMemoryFs` impl + unit tests | `packages/kuralle-fs/src/in-memory-fs.ts`, `test/in-memory-fs.test.ts` | REQ-1, `test:inmemoryfs` | read/write/readdir/stat/rm round-trip green |
| C4 | `createFsTool` factory (all 7 ops, structured returns, EROFS/ENOENT) | `packages/kuralle-fs/src/tool.ts`, `test/fs-tool.test.ts` | REQ-2,REQ-3, `test:fs-tool` | each op returns structured data; readOnly write → EROFS |
| C5 | Core wiring: `AgentConfig.workspace`, `RunContext.fs`, auto-register in `Runtime.ts`, set `ctx.fs` | `kuralle-core/src/types/agentConfig.ts`, `types/run-context.ts`, `runtime/Runtime.ts`, `runtime/ctx.ts` | REQ-4,REQ-5, `test:workspace-autoregister` | agent with `workspace` exposes the `workspace` tool; `ctx.fs` set in an action node |
| C6 | Workers parity test + Node example | `packages/kuralle-fs/test/workers.test.ts` (vitest-pool-workers), `packages/kuralle-fs/examples/kb-agent.ts` | REQ-6, `test:fs-workers` | fs tool round-trips inside workerd AND in the Node example |
| C7 | Reconcile orphaned `FilePersistentMemoryStore` (re-express as FileSystem-backed or document) | `kuralle-core/src/memory/blocks/*`, guide note | REQ-7 | no duplicate store; relationship documented/tested |
| C8 | Docs: package README, core guide update, CHANGELOG/changeset | `packages/kuralle-fs/README.md`, `packages/kuralle-core/guides/TOOLS.md`, `.changeset/*` | REQ-8 | docs show `workspace` usage; changeset present |

## 9. Validation and Testing

### 9.0 Validation contract
| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1..8 | §3 | as stated |
| test:inmemoryfs | §9.1 | InMemoryFs round-trips all interface ops |
| test:fs-tool | §9.1 | createFsTool ls/cat/grep/find/read/write/edit structured returns; EROFS on readOnly write |
| test:workspace-autoregister | §9.1 | `defineAgent({workspace})` → model sees a `workspace` tool; executes via journal |
| test:fs-workers | §9.1 | fs tool round-trips inside vitest-pool-workers |
| cmd:gate | §9.3 | `bun run typecheck:all && bun run test` green |

### 9.1 Fail-to-pass tests
- `test:inmemoryfs`, `test:fs-tool`, `test:workspace-autoregister`, `test:fs-workers` (as above).

### 9.2 Regression (pass-to-pass)
- `packages/kuralle-core/test/**`; existing tool/executor tests must stay green (the fs tool is just another effect tool).

### 9.3 Validation commands
```bash
bun run build && bun run typecheck:all && bun run test
rg -n "node:" packages/kuralle-fs/src/interface.ts packages/kuralle-fs/src/in-memory-fs.ts   # expect no matches
bun packages/kuralle-fs/examples/kb-agent.ts     # live: agent lists+reads bundled docs
```

## 10. Security Considerations
The fs tool inherits the durable executor's enforcer/approval gates (RFC-01). `readOnly` workspaces (RFC-03) prevent mutation. `InMemoryFs` is process-local. Path traversal: `path-utils` normalizes; the fs root is the boundary (no escape above root). No new network surface.

## 11. Rollback and Abort Criteria
- Abort if: the copied `FileSystem` interface cannot stay `node:*`-free after adding `createFsTool` — escalate; portability is the whole point.
- Abort if: wiring `workspace` into `Runtime.ts` regresses the executor merge (RFC-01 must be green first).
- Rollback: the package is additive; remove the `workspace`/`fs` fields and the auto-register to revert. No data migration.

## 12. Open Questions
- Q1: Copy cloudflare-agents fs verbatim (license/attribution) or re-author to match? — tradeoff: speed/proven-Workers-clean vs license hygiene. **Proposal:** Re-author from the same shape with attribution in the package README (interfaces aren't copyrightable; avoids license entanglement), keeping signatures identical for interop.
- Q2: Where does the `FileSystem` *type* live to keep the dep graph one-directional? — tradeoff: in core (core owns the contract) vs in fs pkg (cohesion). **Proposal:** declare the interface in `kuralle-core/src/types/filesystem.ts`, re-export from `@kuralle-agents/fs` (avoids stale-dist trap; core's `workspace` field has no runtime fs dep).
- Q3: One `workspace` tool with an `op` union, or separate `ls/cat/grep` tools? — tradeoff: one tool (smaller model surface, matches Mintlify) vs discoverability. **Proposal:** one `workspace` tool with an `op` discriminated union; revisit if eval shows the model struggles to pick ops.
