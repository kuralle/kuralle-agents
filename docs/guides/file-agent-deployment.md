# File-authored agent deployment

Kuralle compiles a folder into an immutable Agent Artifact, then joins that artifact to an immutable
Runtime Revision in a Release. The first request for a thread atomically records both identities.
Changing a draft or activating another release affects only threads that do not have a pin.

For a runnable Node host and a verified `kuralle chat` command, see
[`examples-deploy/kuralle-file-agent-chat`](../../examples-deploy/kuralle-file-agent-chat/README.md).

## Author the agent

```text
agent/
  instructions.md
  agent.json
  tools/**/*.ts
  flows/**/*.ts
  policies.ts
  skills/<name>/SKILL.md
  skills/<name>/references/**
  references/**
  workspace/**
  subagents/<id>/**
```

`instructions.md` is required. `agent.json` contains serializable identity/model/limit fields. Tool,
flow, and policy modules are parsed during discovery and statically imported only by the generated
runtime bundle. Arbitrary uploaded TypeScript is not executed by the control plane. Unknown slots,
symlinks, case-fold collisions, malformed exports/skills, credentials, and quota violations fail the
build.

`references/**` becomes a read-only `/references` mount. `workspace/**` is copied exactly once into
the thread-private `/workspace` mount. Node keys the persistent-volume directory by tenant, thread,
and agent; a generic Cloudflare thread Durable Object owns its SQLite workspace. Artifact metadata is
kept outside the visible mount. Model writes remain disabled unless the host opts in explicitly.

## Build for Node or Docker

```bash
kuralle build --agent ./agent --target node \
  --default-model openai/gpt-5-mini \
  --host ./deployment.node.ts --out .kuralle
kuralle start --app .kuralle/node/server.mjs
```

The host module default export is called with:

```ts
{
  artifacts,                 // canonical root and subagent artifacts
  artifactBlobs,             // base64 map keyed by sha256:<digest>
  rootArtifactDigest,
  runtimeRevisionSeed,       // capability-module content identity
  runtimeCapabilities,
}
```

It returns `DeploymentRouterOptions`. Configure `PostgresDeploymentStore`,
`PostgresThreadExecutionCoordinator`, a durable `SessionStore`, authenticated principal resolution,
and model/capability registries. Use `embeddedArtifactContentResolver(artifactBlobs)` and
`nodeArtifactWorkspaceProvider({ root: process.env.KURALLE_WORKSPACE_ROOT! })`. Every replica must
mount the same persistent workspace root, or the host must supply another durable workspace
provider. Pre-publish the entity/version/runtime/release into Postgres before admitting traffic.

The generated Dockerfile copies only `server.mjs`, runs as the unprivileged `node` user, and checks
`/health/ready`. SIGTERM stops admission, waits for active streams, then exits. The Postgres lease
prevents two replicas from executing the same thread concurrently.

## Build for Cloudflare

```bash
kuralle build --agent ./agent --target cloudflare \
  --default-model openai/gpt-5-mini \
  --host ./deployment.cloudflare.ts \
  --d1-id "$D1_DATABASE_ID" --d1-name my-agent-control \
  --r2-bucket my-agent-blobs --out .kuralle
wrangler deploy --config .kuralle/cloudflare/wrangler.jsonc
```

The Cloudflare host factory receives the Node fields plus `registerGeneratedCapabilities`. It returns
`{ agent, worker }`: `agent` is the one exported generic `KuralleThreadAgent` class and `worker` is the
front Worker handler. Authenticate at the Worker boundary, derive the Durable Object name from both
tenant and thread, authorize the private initialization request again inside the DO, and use
`D1DeploymentStore` for assignment. Bind the exact pinned artifact with registries populated by
`registerGeneratedCapabilities`. Use `durableObjectArtifactWorkspaceProvider` for DO SQLite/R2 and
either the embedded resolver or `r2ArtifactContentResolver` for revision blobs.

The generated Wrangler config declares the SQL-backed DO through Cloudflare's `exports` field, a D1
binding `KURALLE_CONTROL`, optional R2 binding `KURALLE_BLOBS`, workerd compatibility flags, and
Workers observability. Existing Workers that already use legacy Durable Object migrations must keep
their migration history; do not replace it during an upgrade. Run `wrangler deploy --dry-run` in CI.
Never put provider keys in the artifact or Wrangler variables; use encrypted secrets and resolve only
aliases declared by the artifact.

## Publish, roll out, and roll back

Folder compilation and a database builder draft both publish through `createArtifact`, so equivalent
inputs produce byte-identical JSON and the same SHA-256 digest. A release allocation must total
10,000 basis points and pair each Agent Version with a compatible Runtime Revision.

- Activate a release to change assignment for new threads.
- Keep old capability versions in the deployed runtime while any pinned thread can reference them.
- Roll back new-thread traffic by activating a prior release; existing thread pins are unchanged.
- Treat Worker/container rollback separately from release rollback. A code rollback is unsafe if it
  removes a runtime revision still named by a pin.
- Cloudflare DO SQLite migrations are forward operations; test migration and Worker rollback
  combinations before production rollout.

## Observe and operate

Every runtime span carries tenant, entity/version, artifact digest, release, runtime revision,
environment/branch, and config/secret generations. Conversation audit events are persisted in the
dedicated audit store and retain an inline crash-safe copy; audit is not inferred from traces.

Alert on readiness failures, lease renewal failures, binding/content verification failures, stream
errors, DO initialization conflicts, D1/R2 errors, and drain timeouts. Logs must not contain prompts,
workspace bytes, tool arguments, tokens, or resolved secrets by default. Retain the build manifest,
artifact JSON, runtime bundle digest, migration tag, and release record for every deployment.
