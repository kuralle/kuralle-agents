# RFC 0003 — Agent revisions and production deployment

**Status:** Accepted for implementation · **Date:** 2026-08-01
**Supersedes:** RFC-0001 and its engineering plan where they define artifact, mutability, and
Cloudflare deployment semantics
**Amends:** an earlier decision §B; skills remain content, but production content is published as an immutable
Agent Revision rather than read from a mutable authoring source
**Research:** [`docs/research/file-agents-deployment/`](../docs/research/file-agents-deployment/README.md)

## 1. Decision

Kuralle will support folder-authored and database-authored agents through one publishing pipeline:

```text
folder or builder draft
        │ validate + compile
        ▼
immutable Agent Revision ── preflight ── Runtime Revision
        │                                  │
        └────────────── Release ────────────┘
                           │ stable assignment on first access
                           ▼
                    immutable Thread Pin
```

An Agent Revision is serializable behavior and content. A Runtime Revision is deployed executable
code and its capability registry. A Release joins compatible revisions and assigns only new
threads. A thread retains its original pin across process restarts, Durable Object eviction,
release changes, and rollback.

Folders are an authoring format, not production state. Database rows are authoring and governance
state, not executable object graphs. Both compile into the same canonical artifact.

## 2. Why this replaces the earlier design

RFC-0001 coupled authoring files directly to runtime behavior and proposed one Durable Object class
per agent. That does not satisfy the new requirements:

- database-created agents cannot create Worker classes, bindings, or migration entries;
- reading mutable prompts or skills at request time makes replay and rollback non-deterministic;
- `AgentConfig` contains closures and class instances, so it is not a storage or wire format;
- a code deployment and an agent configuration publication have different lifecycles;
- a global "active agent" pointer cannot preserve old behavior for an existing thread.

The earlier filesystem and skill primitives remain useful. Their role changes: build-time source,
immutable revision content, and isolated per-thread workspace—not a shared mutable control plane.

## 3. Scope

This RFC includes:

- one strict, versioned Agent Artifact for folder and database publishing;
- immutable entities, versions, branches, releases, and thread pins;
- trusted compiled, HTTP/OpenAPI, MCP, built-in, and client tool references;
- a generic Cloudflare thread Durable Object and a Node/Bun host with identical semantics;
- artifact/runtime compatibility checks, observability, audit, tenancy, rollout, and rollback;
- deterministic folder discovery and round-trip import/export.

This RFC does not include arbitrary user-uploaded JavaScript or TypeScript. Executing untrusted code
requires a separately designed sandbox product. It also does not make a mutable filesystem an audit
log, dynamically import generated source in production, or silently degrade unsupported features.

## 4. Domain model

### 4.1 Stable identity and immutable behavior

An **Agent Entity** is a tenant-owned stable identity containing slug, ownership, visibility,
status, and an optional active-version pointer. It is not executable.

A **Draft** is mutable authoring state. Production traffic can never resolve a draft.

An **Agent Version** points to exactly one immutable Agent Artifact. Publishing is append-only: an
existing version, artifact, or digest cannot be edited in place.

A **Runtime Revision** identifies the deployed application build, supported artifact schema/range,
and registry of executable capabilities. The identifier must be injected by CI and remain stable
for the lifetime of the deployment.

A **Release** belongs to one tenant, environment, and agent entity. It contains one or more weighted
allocations. Each allocation joins an Agent Version with a compatible Runtime Revision.

A **Thread Pin** contains, at minimum:

```ts
interface ThreadPin {
  tenantId: string;
  threadId: string;
  agentEntityId: string;
  agentVersionId: string;
  artifactDigest: string;
  runtimeRevisionId: string;
  releaseId: string;
  branch?: string;
  environment: string;
  configGeneration: number;
  secretGeneration: number;
  assignedAt: string;
}
```

The first authorized access creates this record atomically. Later accesses must return the same
record or fail. Moving a branch, activating a version, changing release weights, or rolling back a
release never mutates an existing pin. Emergency revocation may block execution, but migration or
forking is explicit and audited.

### 4.2 Persistence model

The minimum control-plane tables are:

- `tenants`;
- `agent_entities`;
- `agent_versions`;
- `branches`;
- `releases` and `release_allocations`;
- `runtime_revisions` and `runtime_capabilities`;
- artifact metadata, immutable blobs, and source provenance.

The minimum data-plane records are:

- `threads`, including the complete pin and a compare-and-swap version;
- append-only `messages`, `runs`, `run_events`, `tool_invocations`, and `audit_events`;
- `jobs`, transactional `outbox`, delivery attempts, and dead letters;
- mutable workspace metadata and immutable/large workspace blobs.

Tenant identity participates in relevant unique constraints and foreign keys. A session or thread
identifier is a routing key, never proof of authorization. Postgres deployments also use row-level
security as defense in depth.

## 5. Canonical Agent Artifact

### 5.1 Requirements

The artifact is strict, serializable, schema-versioned, deterministic, content-addressed, and safe
to validate in `workerd`. Unknown fields fail validation. It contains no closures, provider clients,
filesystem handles, credential values, absolute source paths, or target-specific objects.

Version 1 contains:

```ts
interface AgentArtifactV1 {
  schemaVersion: 1;
  artifactId: string;
  digest: string; // lowercase SHA-256 of canonical content, excluding digest
  compiler: { name: 'kuralle'; version: string };
  runtimeApiRange: string;
  agent: {
    id: string;
    name?: string;
    description?: string;
    model: string;
    controlModel?: string;
    limits?: Record<string, number>;
    handoffs?: string[];
  };
  instructions: ContentEntry[];
  skills: SkillArtifact[];
  references: ContentEntry[];
  workspaceSeed: ContentEntry[];
  agents: AgentNode[];
  tools: ToolReference[];
  flows: CapabilityReference[];
  policies: PolicyArtifact;
  requiredCapabilities: CapabilityRequirement[];
  secretRefs: SecretReference[];
  sourceMap: SourceMapEntry[];
}
```

Every content entry has a normalized relative path, SHA-256, byte length, media type, semantic role,
and either bounded inline content or an immutable blob reference. Skill hashes cover the complete
package, including references and assets, not only `SKILL.md`.

Canonical encoding recursively sorts object keys while preserving array order. Source compilers
must sort discovered paths before producing semantic arrays. The digest covers all fields except
`digest`; `artifactId` is stable input identity and is included. The first implementation uses
Web Crypto SHA-256 so Node/Bun and `workerd` compute identical values.

### 5.2 Runtime binding

`AgentConfig` remains the live execution shape. A runtime factory:

1. verifies schema, digest, optional signature, and tenant ownership;
2. verifies the active Runtime Revision supports `runtimeApiRange` and every required capability;
3. resolves model and secret aliases under tenant policy;
4. binds references to trusted implementations;
5. mounts revision content read-only and creates an isolated thread workspace;
6. produces `AgentConfig` and `HarnessConfig` for the pinned thread.

No fallback may remove an unsupported tool, flow, policy, or skill. Preflight fails before traffic.

## 6. Authoring surfaces

### 6.1 Folder convention

```text
kuralle.config.ts
agents/<agent-id>/
  instructions.md                 required
  agent.json                      optional serializable artifact fields
  tools/**/*.ts                   trusted compiled capability modules
  flows/**/*.ts                   trusted compiled capability modules
  policies.ts                     trusted compiled policy binder
  skills/<skill>/SKILL.md         Agent Skills package
  references/**                   immutable, selectively loaded context
  workspace/**                    seed copied into a new thread workspace
  subagents/<id>/...              same shape
```

`instructions.md` and `agent.json` have no overlapping-config precedence rule: prose belongs to the
former and strict serializable fields to the latter. TypeScript is allowed only for capabilities
that become part of a Runtime Revision.

Discovery must not execute authored modules. It never follows symlinks; normalizes and bounds paths;
rejects unknown slots, collisions, cycles, secrets, unsupported media, and quota violations; sorts
inputs; accumulates typed diagnostics; emits a source map and dependency graph; and fails target
compatibility explicitly. Development may hot-reload disposable drafts. `publish` always creates a
new immutable artifact.

### 6.2 Database builder

The builder writes mutable drafts conforming to the same strict serializable schema. Publishing
validates and compiles a draft to the identical artifact that an equivalent folder produces.

Tools in v1 are references to:

- trusted capabilities compiled into the Runtime Revision;
- signed HTTPS/OpenAPI operations;
- MCP servers with explicit transport and authentication policy;
- built-in platform tools;
- client-side tools whose result protocol is validated.

Secret references are aliases. Values are stored and resolved outside drafts and artifacts. Import
and export round-trip between builder data and the folder convention without making either source
authoritative after publication.

## 7. Release behavior

Publishing does not send traffic. A release is separately created, preflighted, and activated.
Weighted assignment uses a stable hash over tenant, environment, agent entity, release, and thread
ID. Repeated assignment therefore produces the same allocation without storing transient randomness.

The recommended gate is 5/25/50/100 percent. Advance after at least 1,000 runs and 30 minutes only
when error rate rises by no more than 0.5 percentage points, p95 latency by no more than 10 percent,
and evaluation score falls by no more than 2 percent. These are defaults, not universal constants.

Rollback changes new-thread assignment. It does not rewrite existing pins. If a defect makes an old
artifact unsafe, revoke it and require an explicit, audited fork/migration policy.

## 8. Cloudflare target

Cloudflare deploys one stable `KuralleThreadAgent` class. Each authorized `(tenantId, threadId)` maps
to one named Durable Object instance. The front Worker authenticates the request, derives a
cryptographic canonical object name, and passes verified identity; a request body never supplies
authoritative tenant identity.

On first access the object resolves a release, verifies compatibility and digest, and atomically
stores the Thread Pin in its private SQLite database. Later requests reject conflicting identity or
pin data before executing a turn.

- Durable Object SQLite owns thread messages, checkpoints, effects, approvals, the pin, and mutable
  workspace metadata.
- R2 owns large revision and workspace blobs.
- D1 or external Postgres owns searchable control-plane indexes.
- Queues export idempotent audit/events with retries and a dead-letter queue.
- Workflows own waits or multi-step operations that exceed the thread execution model.

Worker code rollout and Durable Object storage migration are separate operations. Schema changes use
expand–migrate–contract because rolling back Worker code does not roll back stored data.

## 9. Node/Bun and Docker target

The Node/Bun host exposes the same contract through Hono. Replicas are stateless except for active
streams. Postgres is canonical for control-plane data, thread state, append-only events, outbox,
and distributed leases. Object storage holds large blobs. Background workers claim idempotent jobs,
retry with bounds, and dead-letter terminal failures.

`kuralle build --target node` emits the server bundle; `kuralle start` runs it. The Dockerfile runs
the same artifact and command. Docker is packaging, not a third runtime model.

Readiness verifies schema versions, control-plane connectivity, active artifact compatibility, and
required capabilities. Shutdown stops admission, drains streams, relinquishes leases, and flushes
telemetry within a configured deadline.

## 10. Observability, audit, and reliability

Every turn, model call, tool invocation, retrieval, and flow emits trace attributes for tenant,
agent entity/version, artifact digest, release/branch/environment, runtime revision, thread/run/
attempt/idempotency identifiers, prompt fragment and skill hashes, retrieved resource IDs/scores,
policy/config/secret generations, tokens, cost, latency, outcome, and error class. Secret values are
never attributes.

Audit is distinct from tracing and append-only. Records include actor, action, target, before/after
hashes, request/trace IDs, policy decision, and timestamp. Writes use a transactional outbox where
the primary state and audit sink cannot share a transaction. Export failure is observable and
dead-lettered; an inline session copy may be a crash-safe fallback but is not the query authority.

Side-effecting tools require idempotency keys at the executor boundary. Concurrency control is
durable: a process-local mutex is insufficient for Node replicas. Every target must survive restart
or eviction without losing pins, checkpoints, messages, effects, audit events, or deduplication.

## 11. Security boundaries

- Control-plane mutation and data-plane execution use separate authenticated authorities.
- Tenant scope is checked before any definition, artifact, thread, or secret store access.
- Artifacts are digest-verified and optionally signature-verified before binding.
- Files enforce count, byte, path, media, archive, and expansion quotas; symlinks and credential
  patterns fail publication.
- Skill prose cannot grant tool or secret authority.
- HTTP/MCP tools require HTTPS, host allowlists, DNS/private-IP checks, redirect revalidation,
  bounded requests/responses, and scoped OAuth or mTLS where appropriate.
- Side effects pass policy and approval at the executor boundary, not only in the prompt.
- Tenant rate, concurrency, token, storage, and spend quotas fail closed.
- Imported skill/code provenance, exact version, license, and source hash are retained.

## 12. Delivery slices and acceptance

Implementation proceeds as independently testable vertical slices:

1. canonical artifact schema, validation, canonical digest, and immutable in-memory ports;
2. release allocation and atomic thread pinning with tenant isolation;
3. capability registries, compatibility preflight, binder, and trace identity;
4. deterministic folder compiler and equivalent database publisher;
5. Node/Postgres host, lease/outbox worker, Docker build, readiness and drain;
6. generic Cloudflare thread object, SQLite pin/state, blob and event adapters;
7. rollout/rollback operations, migrations, examples, and production runbooks.

The decisive integration test publishes v1, starts thread A, activates v2, and proves A stays on v1
while new thread B receives v2. After Node restart or Durable Object eviction both pins, messages,
checkpoints, audit events, and trace identities remain. Cross-tenant reads fail before store access,
a repeated side-effect delivery produces one effect, and rollback changes only future threads.

## 13. Flip conditions

These choices are intentional but revisitable with evidence:

- Add an untrusted-code sandbox only when builder users require arbitrary code often enough that
  HTTP/MCP/catalog tools cannot cover the demand and isolation, egress, billing, and provenance are
  independently designed.
- Add runtime-mutable content overlays only when measured publication latency cannot meet an agreed
  operational target; overlays must themselves be immutable, pinned, hashed revisions.
- Split the generic Durable Object class only when a separately deployed product requires a
  different storage schema or jurisdictional boundary—not merely because it has another agent ID.
- Move control-plane data from D1/Postgres only when measured consistency, query, or scale limits
  justify it; the ports and artifact contract remain unchanged.
- Introduce workspace collaboration only with explicit multi-writer semantics, conflict handling,
  quotas, and ownership. A shared directory is not concurrency control.

## 14. Provenance

The design was derived from firsthand inspection of Eve, Flue, Mastra, MWP/ICM, Agent Skills, and
Pydantic AI plus official hosted-platform documentation. Exact commits, licenses, source paths,
hosted references, rejected patterns, and confidence limits are recorded in
[`sources.md`](../docs/research/file-agents-deployment/sources.md) and
[`prior-art.md`](../docs/research/file-agents-deployment/prior-art.md). No inspected source was copied.
