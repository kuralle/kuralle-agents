# ADR 0013 — Persistent FileSystem backends (platform-chosen)

**Status:** Accepted · **Date:** 2026-07-09 · **Extends:** ADR-0012 (workspace/shell/skills)

## Context

`@kuralle-agents/fs` shipped one `FileSystem` backend — `InMemoryFs` (ephemeral, per-process). The teardown (`docs/kuralle-core-teardown.md`, H3) exposed the resulting contradiction: kuralle's **durable** tool journal sits over an **ephemeral** fs, so after a restart the journal replays "write succeeded" while the fresh in-memory tree is empty — ghost writes. There was also no CF-native persistent workspace.

Notably, kuralle's `FileSystem` interface was re-authored from the Cloudflare Agents SDK's `@cloudflare/shell`, which already ships the durable half — `WorkspaceFileSystem` (SQL + R2). kuralle copied the in-memory backend and left the persistent one behind. Turso's AgentFS (SQLite-per-agent) validates the same SQLite-as-agent-fs model.

## Decision

Ship a **persistent `FileSystem` chosen by platform**, behind the unchanged `FileSystem` interface, over one minimal storage primitive.

### A. The primitive — a two-method `SqlBackend`
```ts
interface SqlBackend { query<T>(sql, ...params): T[] | Promise<T[]>; run(sql, ...params): void | Promise<void>; }
interface BlobStore { get(key): Promise<Uint8Array|null>; put(key, data): Promise<void>; delete(key): Promise<void>; }
```
Everything composes on these. `query`/`run` are sync-or-async so DO SQLite (sync) and D1 (async) both fit.

### B. `SqlFileSystem` — a drop-in for `InMemoryFs`
`SqlFileSystem implements FileSystem` over a `SqlBackend` (+ optional `BlobStore`). Single path-keyed table (`<ns>_files`), `parent_path` indexed for `readdir`, small content stored inline, large content (≥ `inlineThreshold`, default 1.5MB) spilled to the `BlobStore`. Same error strings and behavior as `InMemoryFs` — proven by a **shared conformance suite** that runs identical assertions against both backends.

### C. Platform factories (OTB — the dev passes the handle they already have)
- **Cloudflare:** `sqlFileSystem(ctx.storage.sql)` (DO SQLite) or `sqlFileSystem(env.DB)` (D1); optional `+ r2BlobStore(bucket)`. Auto-detected via a `toSqlBackend` (`databaseSize`→DO, `prepare`+`batch`→D1, else raw). Structural CF types — no `@cloudflare/workers-types` dep. Root export, Workers-clean.
- **Node:** `nodeSqlFileSystem('/path/agent.db')` via the built-in `node:sqlite` (Node ≥ 22.5). `@kuralle-agents/fs/node` subpath.
- **Bun / anything:** wrap the SQLite handle in a 3-line `SqlBackend` and pass it to `sqlFileSystem(...)`.

## Consequences
- Ghost-writes fixed: fs state is durable, so the fs and the durable journal agree across restarts (proven live — a file + skill written by one `SqlFileSystem` are read by a second over the same store).
- CF agents get a real persistent workspace on DO-SQLite / D1 / R2 — verified on **real workerd** (workers-vitest over a Durable Object's `ctx.storage.sql`).
- Skills persist automatically: `fsSkillStore` reads any `FileSystem`, so pointing it at a `SqlFileSystem` makes SKILL.md skills durable with zero new code.
- `FileSystem` interface unchanged — `workspace`, `bash`, `createFsTool`, `fsSkillStore`, and OKF all keep working, now durably.

## Platform / portability
- `SqlFileSystem`, `sqlFileSystem`, `r2BlobStore`, types: **zero `node:*`** — Workers-clean; DO SqlStorage (sync) and D1 (async) both drive it.
- `nodeSqlFileSystem`: `node:sqlite` — Node-only, `/node` subpath (Bun lacks `node:sqlite`; Bun users pass a `bun:sqlite` `SqlBackend` to `sqlFileSystem`).
- R2 typed structurally; `blobs` optional ⇒ everything inline for pure-SQL deployments.

## Non-goals / rejected
- The general journal-scoping fix (F4/F6) — separate RFC; this ADR makes the *fs* durable, which removes the ghost-writes class specifically.
- Overlay / commit-discard staged workspace (Mirage model) — future; pairs with durable HITL approval.
- A KV store / tool-call audit surface (Turso AgentFS adds these) — out of scope; fs only.
