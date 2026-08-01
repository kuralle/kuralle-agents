# Selected architecture

## Terminology

- **Agent entity:** stable tenant-owned identity and governance metadata.
- **Draft:** mutable authoring state, never executable by production traffic.
- **Agent Revision:** immutable canonical behavior/resource snapshot.
- **Runtime Revision:** deployed code and the executable capability registry it exposes.
- **Release:** environment-specific weighted allocation joining Agent Revisions with compatible
  Runtime Revisions.
- **Thread pin:** immutable assignment created on a thread's first turn.
- **Artifact:** canonical encoded Agent Revision plus referenced blobs and source map.

## Canonical artifact

The schema must be serializable, strict, versioned, deterministic, and workerd-safe. The first
version should contain:

```ts
interface AgentArtifactV1 {
  schemaVersion: 1;
  artifactId: string;
  digest: string;                 // SHA-256 of canonical content, excluding this field
  compiler: { name: 'kuralle'; version: string };
  runtimeApiRange: string;

  agent: {
    id: string;
    name?: string;
    description?: string;
    model: string;
    controlModel?: string;
    limits?: SerializableLimits;
    handoffs?: string[];
  };

  instructions: ContentEntry[];
  skills: SkillArtifact[];
  references: ContentEntry[];
  workspaceSeed: ContentEntry[];
  agents: AgentNode[];            // explicit acyclic subagent graph

  tools: ToolReference[];
  flows: CapabilityReference[];
  policies: PolicyArtifact;
  requiredCapabilities: CapabilityRequirement[];
  secretRefs: SecretReference[];  // aliases only; never values
  sourceMap: SourceMapEntry[];
}
```

Every content entry carries normalized path, SHA-256, byte size, media type, role, and either small
inline content or an immutable blob reference. Canonical JSON ordering makes a folder compile and a
database compile byte-identical when their logical definitions are equal.

`AgentConfig` remains the executable runtime shape. A `RuntimeFactory` validates an artifact against
the current runtime revision, resolves model and secret aliases, binds capability references to
trusted implementations, mounts revision files read-only, creates the isolated thread workspace,
and finally produces `AgentConfig`/`HarnessConfig`.

## File authoring contract

The clean file convention is deliberately smaller than the earlier RFC:

```text
kuralle.config.ts
agents/<agent-id>/
  instructions.md                 required
  agent.json                      optional serializable Agent Revision fields
  tools/**/*.ts                   trusted source capability modules
  flows/**/*.ts                   trusted source capability modules
  policies.ts                     trusted source policy binder
  skills/<skill>/SKILL.md         complete Agent Skills package
  references/**                   immutable, selectively loaded context
  workspace/**                    seed copied to each new thread workspace
  subagents/<id>/...              same shape, compiled as an explicit graph
```

`instructions.md` aligns with Eve and Mastra. `agent.json` uses the same strict schema as the
builder; it is round-trippable and cannot hide executable behavior. TypeScript belongs only in
capability modules compiled into a runtime revision. This removes the ambiguous markdown-vs-code
precedence rules in RFC-0001.

Discovery is filesystem-only and deterministic:

- never follow symlinks;
- reject unknown slots, path traversal, duplicate/folded identities, cycles, secrets and quotas;
- sort paths before hashing/codegen;
- accumulate typed diagnostics;
- do not import user modules during discovery;
- hash every packaged file, not only `SKILL.md`;
- generate source maps and dependency edges;
- fail target compatibility rather than silently dropping a feature.

Development may hot-reload disposable draft revisions. `publish` always freezes a new artifact.

## Database authoring contract

The control plane stores drafts and immutable versions, not live `AgentConfig` values.

```text
agent_entities
  id, tenant_id, slug, status, owner_id, visibility, active_version_id, metadata

agent_versions
  id, tenant_id, agent_id, version_number, digest, artifact_ref, created_by, created_at

branches
  id, tenant_id, agent_id, name, head_version_id

releases / release_allocations
  environment, branch/version, runtime_revision, weight, state
```

Tool selection is stored as catalog/HTTP/MCP references. Builder users can create agents instantly
when they only change serialized behavior. New trusted executable code still requires a runtime
deployment. Import/export maps database drafts to the same folder convention; neither is treated as
more authoritative than the canonical artifact.

## Release and thread semantics

1. Validate and publish an immutable Agent Revision.
2. Preflight it against a Runtime Revision's capabilities and schema range.
3. Assign weighted release traffic using a stable hash of tenant + thread ID.
4. Atomically persist `agentVersionId`, `artifactDigest`, `runtimeRevisionId`, `releaseId`, branch,
   environment, and configuration/secret generations on thread creation.
5. Every later turn uses the pin. A moved branch or active-version pointer has no effect.
6. Rollback changes assignments for new threads. Existing retained threads keep their artifacts.
7. Emergency revocation may block an artifact; migration/forking is explicit and audited.

Suggested rollout gate: 5/25/50/100 percent. Advance after at least 1,000 runs and 30 minutes only
when error rate rises by at most 0.5 percentage points, p95 latency by at most 10%, and evaluation
score falls by at most 2%.

## Required data-plane records

- `threads`: tenant, owner/user, channel, agent/version/release/runtime pins, status and CAS version;
- append-only `messages`, `runs`, `run_events`, `tool_invocations`, `audit_events`;
- `jobs`, transactional `outbox`, delivery attempts and dead letters;
- artifact metadata/file tree and immutable blob store;
- secret aliases/generations separate from artifacts.

Tenant identity participates in every relevant unique key and foreign key. Postgres deployments
should additionally enforce row-level security. Session IDs are routing keys, never authorization.

## Cloudflare adapter

Deploy a single stable `KuralleThreadAgent` class. Each `(tenantId, threadId)` maps to a named
instance with private SQLite. The front Worker authenticates the request and derives the name from
a canonical cryptographic encoding; request bodies never supply authoritative tenant identity.

On first access the DO resolves and atomically pins a release, verifies the artifact hash/runtime
compatibility, and initializes thread state. Later requests reject conflicting identity or pins.
Use:

- DO SQLite for thread messages, checkpoints, effects, approvals and mutable workspace metadata;
- R2 for large revision blobs/workspace objects;
- D1 or an external control-plane database for searchable global indexes;
- Queues for idempotent audit/event export with DLQ;
- Workflows for long multi-step work or waits that exceed the thread execution model.

Worker code rollout and DO schema migration are separate. Use additive expand–migrate–contract
changes because Worker rollback does not roll back DO storage.

## Node/Bun adapter

Expose the same host through Hono. Replicas are stateless except for active streams. Postgres owns
definitions, release assignment, thread state, audit, queue/outbox and distributed leases; object
storage owns large blobs. A worker drains jobs with idempotency keys, retries and dead letters.

`kuralle build --target node` emits a self-contained server bundle. `kuralle start` executes it.
The supplied Dockerfile starts the same command; Docker does not define different semantics.
Readiness checks schema versions, artifact compatibility and required capability availability.
Shutdown stops admission and drains active streams.

## Observability and audit

Trace every turn/model/tool/retrieval/flow and attach:

- tenant, agent entity/version, artifact digest, release/branch/environment, runtime revision;
- thread/run/attempt/idempotency identifiers;
- prompt fragment and skill package hashes;
- retrieved resource identifiers/scores;
- policy, config and secret generations (never secret values);
- token/cost/latency/outcome/error data.

Audit is separate from traces and append-only. Record actor, action, target, before/after hashes,
request/trace IDs, policy decision and timestamp. Redact content before export, define retention per
tenant, and make export failures observable through an outbox/DLQ.

## Security boundaries

- Separate authenticated control-plane mutation from data-plane execution.
- Verify artifact digests/signatures and compiler/runtime compatibility.
- Enforce file count/size/path/media quotas and reject symlinks and credential patterns.
- Resolve scoped secret aliases only at execution time.
- Protect HTTP/MCP tools from SSRF: HTTPS, host allowlists, DNS/private-IP validation, redirect
  revalidation, response/time limits, scoped OAuth or mTLS.
- Require idempotency for side effects and policy/approval checks at the executor boundary.
- Apply tenant rate, concurrency, token, storage and spend quotas.
- Treat imported skills and code modules as supply-chain inputs; provenance and licenses are part of
  the artifact.

## Explicitly rejected

- production requests reading mutable source folders;
- converting database rows to temporary TypeScript files and dynamically importing them;
- one Cloudflare DO class/binding/migration per agent;
- storing closures or secrets in definition rows;
- arbitrary uploaded code in the first release;
- existing threads silently adopting the latest definition;
- filesystem visibility presented as a durable audit trail;
- target-specific feature degradation hidden behind one schema.

