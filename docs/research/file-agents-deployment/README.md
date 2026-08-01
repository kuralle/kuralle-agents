# File-authored agents and production deployment

**Decision date:** 2026-08-01  
**Status:** decision-ready; implementation contract in
[`../../../rfcs/0003-agent-revisions-and-production-deployment.md`](../../../rfcs/0003-agent-revisions-and-production-deployment.md)

## Verdict

Kuralle should use folders as an authoring format, not as mutable production state.
File-authored agents and builder/database-authored agents compile to the same immutable,
content-addressed **Agent Revision**. A published release assigns revisions to new threads; a
thread pins its revision when it is created and never silently follows `latest`.

The production invariant is:

```text
folder authoring ─┐
                  ├─ validate + normalize ─► Agent Revision ─► release ─► pinned thread
builder / DB ─────┘                               │
                                                 ├─ Node/Bun (bare or Docker)
                                                 └─ Cloudflare Worker + generic thread DO
```

This is the simplest design that satisfies both goals together. It preserves the inspectability
and portability of files, while giving a SaaS control plane immutable versions, rollback, tenant
isolation, reproducible conversations, and target-neutral deployment.

## Why this decision

- Kuralle's `AgentConfig` is a live object graph containing closures, tools, flows, policies,
  model objects, and workspace resolvers. Persisting it as JSON is impossible and pretending
  otherwise would create target-specific behavior.
- Eve and Mastra both discover folders at build time and compile ordinary runtime modules. They do
  not rediscover a source tree on every production request.
- Mastra's current database model separates a thin mutable agent entity from complete version
  snapshots. ElevenLabs adds the missing release semantics: immutable versions, branches,
  deterministic traffic allocation, and conversation stickiness.
- MWP/ICM explicitly says its filesystem protocol is not enough for high concurrency, dynamic
  branching, or multi-user isolation. Its useful contribution is layered context and visible
  dependency contracts, not production state management.
- Cloudflare deploys Durable Object *classes* with Worker code, but creates arbitrary numbers of
  instances by name. A database-created agent cannot create a new class or migration. Therefore
  one generic class per runtime and one instance per thread is the correct mapping.

## Four separate namespaces

1. **Definition source** — editable folder or builder draft.
2. **Revision resources** — immutable instructions, skill packages, reference files, provenance,
   and content hashes.
3. **Thread workspace** — mutable files isolated by tenant, agent, and thread.
4. **Runtime state** — messages, checkpoints, effects, approvals, jobs, traces, and audit events in
   durable stores.

Mixing any two creates concrete failures: changing instructions in the middle of a conversation,
sharing mutable files between tenants, treating visible files as an audit log, or requiring an
infrastructure deploy for ordinary builder CRUD.

## Context policy

- Keep always-on identity and instructions short.
- Put occasional procedures in Agent Skills: metadata in the catalog, body and resources loaded
  only on activation.
- Compile explicit MWP-style input/file relationships into dependency edges and provenance.
- Use direct files for small curated reference sets; use retrieval for collections that justify an
  index. Do not dump an entire folder into every prompt.
- Record the revision digest, prompt-fragment hashes, activated skills, retrieved resources,
  policy version, model configuration, and tenant/thread identity on each run.
- A `SKILL.md` may request tools, but cannot grant authority. Effective access is the intersection
  of revision policy, tenant policy, principal/channel policy, and approval state.

## Tool policy

Portable tool references, in order:

1. a trusted capability compiled into the runtime revision;
2. a signed HTTP/OpenAPI tool;
3. a remote MCP server;
4. a platform built-in or client-executed tool.

Database-authored arbitrary TypeScript is not supported. It requires a separate hardened sandbox
product with resource isolation, egress controls, secret mediation, and an explicit threat model.
It must not be smuggled into the initial definition schema.

## Target policy

Node/Bun and Cloudflare consume the same Agent Revision and capability contract. Docker is only a
packaging option for the Node runtime.

- **Cloudflare:** authenticate in the front Worker; derive a generic Durable Object name from
  `(tenantId, threadId)`; atomically pin the release on first access; use private DO SQLite for
  thread state, R2 for large immutable blobs, and Queues/Workflows for exported events or long work.
- **Node/Bun:** stateless HTTP/streaming replicas; Postgres for definitions, threads, audit and the
  outbox; object storage for large blobs; a distributed per-thread lease/queue; graceful draining.

## Existing Kuralle evidence

Already present:

- portable `FileSystem` backends, session-scoped workspace resolution, safe filesystem tools;
- Agent Skills progressive prompt disclosure and skill content hashes on traces;
- CAS-aware Redis/Postgres stores, durable effects, approvals/resume, and Node/CF examples.

Missing before this work:

- folder discovery/compiler/package;
- serializable revision schema and immutable store;
- database-defined agents and capability binding;
- release assignment and thread revision pinning;
- mandatory tenant ownership boundary;
- production build/start targets;
- a reliable production audit path.

The audit path had a confirmed defect: Core wrote entries only into session metadata, Redis and
Postgres replayed their separate empty audit stores, and the Cloudflare bridge discarded metadata.
The first code change on this branch persists turn deltas to dedicated stores, merges the inline
crash-safe copy on replay, and round-trips metadata through the Cloudflare bridge.

## Documents

- [`prior-art.md`](prior-art.md) — firsthand framework and platform comparison.
- [`architecture.md`](architecture.md) — selected architecture, data model, target adapters, and
  security boundaries.
- [`BUILD-READY.md`](BUILD-READY.md) — implementation order and proof gates.
- [`sources.md`](sources.md) — primary sources, inspected commits, and licenses.

## Flip conditions

- A mutable live-folder runtime is allowed only for local, single-user development. Publishing
  always freezes a revision.
- Add uploaded-code sandboxes only when at least 20% of paid tenants require them, an isolation
  pilot has zero escapes, p95 startup is under one second, and cost is below twice an HTTP tool.
- Replace explicit context dependencies with automatic retrieval only after gold-context recall is
  at least equal and token usage is lower.
- Keep one generic thread DO until more than 5% of operations require cross-thread atomicity or its
  measured throughput/storage SLO is breached; then add a targeted coordinator, not agent classes.
- Preserve revision pinning. Add explicit thread migration only if support demand exceeds 10% of
  incidents and compatibility tests reach 99.99%; never make migration implicit.

