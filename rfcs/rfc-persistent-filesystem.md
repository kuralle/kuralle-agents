# RFC — Persistent FileSystem backends (platform-chosen, OTB)

**Status:** Draft → executing · **Date:** 2026-07-09 · **Owner:** octalpixel (manager-orchestrated)
**Relates to:** ADR-0012 (workspace/shell/skills), `docs/kuralle-core-teardown.md` (H3 "ghost writes": durable journal over an *ephemeral* fs), the CF Agents SDK `@cloudflare/shell` `WorkspaceFileSystem` (kuralle's `FileSystem` interface origin), Turso AgentFS.
**Grounded first-hand:** `research/cloudflare-agents-sdk/packages/shell/src/filesystem.ts` (SqlBackend + schema + R2 spillover), `tursodatabase/agentfs` (SQLite-per-agent model).

## 1. Problem & goal

`@kuralle-agents/fs` ships exactly one `FileSystem` backend — `InMemoryFs` (ephemeral, per-process). The teardown found the resulting contradiction: kuralle's **durable** journal sits over an **ephemeral** fs, so after a restart the journal replays "write succeeded" while the fresh in-memory tree is empty (ghost writes). And there is no CF-native persistent workspace at all. Meanwhile the *upstream kuralle's `FileSystem` interface was copied from* — CF Agents SDK's `@cloudflare/shell` — already ships the durable half (`WorkspaceFileSystem`: SQL + R2), which kuralle left behind.

**End state (the "1"):** a developer picks their platform and gets a **persistent** `FileSystem` with the right storage primitive, behind the unchanged `FileSystem` interface — so `workspace`, `bash`, and `fsSkillStore` all keep working, now durably:
- **Cloudflare:** `sqlFileSystem(ctx.storage.sql)` (DO SQLite) or `sqlFileSystem(env.DB)` (D1), optional `+ R2` for large files.
- **Node:** `nodeSqlFileSystem('/path/agent.db')` (SQLite on disk).
- **Anywhere / tests:** any object satisfying the two-method `SqlBackend`.

Persistence fixes ghost-writes (fs and journal now agree), gives a real CF workspace, and makes skills durable automatically (`fsSkillStore` reads any `FileSystem`).

**Non-goals:** the general journal-scoping fix (F4/F6 — separate RFC); an overlay/commit-discard staged workspace (Mirage model — future); a KV/toolcall-audit surface (Turso adds these; out of scope — we implement the fs only); changing the `FileSystem` interface.

## 2. Design principles (from the reference)

- **One minimal storage primitive** (CF's seam, verbatim): `SqlBackend { query(sql, ...params): T[]|Promise; run(sql, ...params): void|Promise }`. Everything else composes on it. Sync-or-async so DO SQLite (sync) and D1 (async) both fit.
- **Auto-detect the platform handle** (CF's `SqlSource`): accept `SqlStorage` (DO), `D1Database`, or a raw `SqlBackend`; adapt internally. The dev passes the handle they already have.
- **Path-keyed single table** (CF's schema): one row per node keyed by absolute `path`, `parent_path` indexed for `readdir`. Small file content stored `inline`; large content spills to a `BlobStore` (R2) above `inlineThreshold`.
- **Same `FileSystem` contract as `InMemoryFs`** — `SqlFileSystem` must pass the *same* test suite (drop-in). No new interface.
- **Node + CF portable at the seam** — the core `SqlFileSystem` is zero-`node:*` (Workers-clean); Node-specific SQLite lives behind the `/node` subpath.

## 3. Interfaces

### 3.1 Storage primitives (`@kuralle-agents/fs` `src/sql/types.ts`)
```ts
export type SqlParam = string | number | boolean | null;
export interface SqlBackend {
  query<T = Record<string, SqlParam>>(sql: string, ...params: SqlParam[]): T[] | Promise<T[]>;
  run(sql: string, ...params: SqlParam[]): void | Promise<void>;
}
// Optional large-file store (R2 / node fs). Absent ⇒ everything inline.
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### 3.2 `SqlFileSystem` (core, `src/sql/sql-fs.ts`)
```ts
export interface SqlFileSystemOptions {
  backend: SqlBackend;
  namespace?: string;      // table isolation, default 'default'
  blobs?: BlobStore;       // large-file spillover (optional)
  inlineThreshold?: number; // bytes; default 1_500_000
}
export class SqlFileSystem implements FileSystem { constructor(opts: SqlFileSystemOptions); async init(): Promise<void>; /* + all FileSystem methods */ }
```
Schema (adapted from CF `filesystem.ts`): table `<ns>_files(path PK, parent_path, name, type, mime_type, size, storage_backend 'inline'|'blob', blob_key, target, content_encoding, content, created_at, modified_at)` + index on `parent_path`. Root `/` seeded on `init()`. `writeFile` ≥ `inlineThreshold` ⇒ `blobs.put()` + `storage_backend='blob'`; else inline. `readdir` = `WHERE parent_path=?`. `rm -r` cascades; `cp/mv` copy/update rows (+ blob copy); `glob` walks rows through the existing `createGlobMatcher`.

### 3.3 Platform factories
- `sqlFileSystem(source: SqlStorage | D1Database | SqlBackend, opts?): SqlFileSystem` (root export, Workers-clean) — auto-detects (CF's `toBackend`: `databaseSize`→DO, `prepare`+`batch`→D1, else raw). `await fs.init()` before use (or lazy-init on first op).
- `r2BlobStore(bucket: R2Bucketish): BlobStore` (root export, structural R2 type — no hard `@cloudflare/workers-types` dep).
- `nodeSqlFileSystem(path: string, opts?): SqlFileSystem` (`@kuralle-agents/fs/node`) — a `SqlBackend` over `node:sqlite` `DatabaseSync` (Node ≥ 22.5; the built-in, zero external dep). `:memory:` supported.
- Test/bun backend: `bunSqlBackend(db)` helper wrapping `bun:sqlite` for the test suite (test-only, not shipped in root).

## 4. Work breakdown (chunks)

| # | Chunk | Paths | DoD | Deps |
|---|---|---|---|---|
| **P1** | `SqlFileSystem` core + schema + inline/blob | `src/sql/{types,sql-fs}.ts` | passes the **same** behavioral tests as `InMemoryFs` against a bun:sqlite backend (read/write/bytes/mkdir/readdir/rm-recursive/cp/mv/symlink/stat/glob/exists); large file (> threshold) round-trips via a fake BlobStore; `init()` idempotent | — |
| **P2** | Platform factories | `src/sql/{factory,r2-blob}.ts`, `src/node/node-sql-fs.ts`, exports + `package.json` `/node` reuse | `sqlFileSystem` auto-detects a raw SqlBackend + a fake SqlStorage/D1 shape; `r2BlobStore` over a fake bucket; `nodeSqlFileSystem(':memory:')` round-trips a file (bun can run node:sqlite? if not, gate the node test) | P1 |
| **P3** | Shared FileSystem conformance suite + CF workers-vitest | `test/sql-fs.test.ts`, `vitest/sql-fs-workers.test.ts` | one parameterized suite runs `InMemoryFs` AND `SqlFileSystem(bun:sqlite)` through identical assertions (proves drop-in); workers-vitest runs `SqlFileSystem` over DO `ctx.storage.sql` in workerd | P1,P2 |
| **P4** | Persistent-workspace example (live) + docs | `examples/persistent-workspace.ts`, README, ADR-0013 | live smoke: write a file + a skill via one `SqlFileSystem`, construct a **second** `SqlFileSystem` over the **same** backend (simulating restart), read them back — proves persistence; ADR documents the primitive + ghost-writes fix | P1,P2,P3 |

## 5. Validation
- `cd packages/kuralle-fs && bun test ./test && vitest run --config vitest.config.ts` — SqlFileSystem passes the shared conformance suite; workers-vitest green on DO SQLite.
- `cd packages/kuralle-core && bun test ./test` — no regression (core `FileSystem` interface unchanged).
- Live: `persistent-workspace.ts` proves a file/skill written by one `SqlFileSystem` is read by a second one over the same store (restart survival) — the ghost-writes fix, observed.

## 6. Portability contract
- `src/sql/*` (core `SqlFileSystem`, factory, r2-blob, types): **zero `node:*`** — Workers-clean; DO SqlStorage (sync) and D1 (async) both drive it.
- `src/node/node-sql-fs.ts`: `node:sqlite` — Node-only, `/node` subpath.
- R2 typed structurally (no hard CF dep). `blobs` optional ⇒ pure-SQL deployments work with everything inline.

## 7. Risks
- **`node:sqlite` availability** — built-in from Node 22.5 (experimental flag on older). If the repo's Node is older, `nodeSqlFileSystem` gates/falls back to documenting `better-sqlite3`; do not add a hard dep without confirming the Node version.
- **bun:sqlite vs node:sqlite in tests** — bun tests use `bun:sqlite` (always present under bun); the workers-vitest uses DO `ctx.storage.sql`. Keep the test SqlBackend adapters tiny and separate.
- **Async-only D1 vs sync DO** — `SqlBackend` methods are `T[] | Promise<T[]>`; `SqlFileSystem` must `await` every call so both work. Never assume sync.
- **Scope creep into KV/audit** (Turso adds these) — out of scope; fs only.

## 8. Delegation plan
grok ICs. P1 (keystone, precise brief with the SqlBackend interface + schema + method list) delegated first, reviewed hard. Then P2. P3 (conformance suite) + P4 (live example) manager-run (needs the shared-suite design judgment + live observation). Same cadence as the shell/skills feature.
