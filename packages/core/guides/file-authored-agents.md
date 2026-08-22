# File-authored Agents

Compile an agent folder into an immutable deployment and chat with it through the Kuralle CLI.

A file-authored agent keeps its declarative behavior in a folder and compiles that folder into an
immutable, content-addressed Agent Artifact. Production execution binds the artifact to a Runtime
Revision and pins that exact pair to the conversation thread.

The runnable example is in
[`apps/examples/file-agent-chat`](https://github.com/kuralle/kuralle-agents/tree/main/apps/examples/file-agent-chat).
It uses `gpt-4.1-mini` and exercises the generated Node server through `kuralle chat`.

## Author the folder

```text
agent/
  instructions.md          # required
  agent.json               # serializable identity, model, and limit fields
  tools/**/*.ts
  flows/**/*.flow.json     # or *.ts
  policies.ts
  skills/<name>/SKILL.md
  skills/<name>/references/**
  references/**
  workspace/**
  subagents/<id>/**
```

Those nine names are the complete slot set (`ROOT_SLOTS` in
`@kuralle-agents/build`). An unknown slot fails the build, as do symlinks,
case-fold collisions, malformed exports or skills, recognizable credentials, and
quota violations. `policies.ts` must export at least one policy phase —
`input`, `output`, `tool`, `refine`, or `validate`.

Tool, flow, and policy modules are parsed during discovery and statically
imported only by the generated runtime bundle; the control plane never executes
uploaded TypeScript.

`flows/*.flow.json` files are declarative `FlowDefinition` graphs. The compiler validates each one
strictly and embeds it inline in the artifact — a bad flow fails the build and names the dotted
issue path. TypeScript modules under `flows/` still compile to capability references resolved from
the host runtime.

`references/**` becomes a read-only `/references` mount. `workspace/**` is copied exactly once into
the thread-private `/workspace` mount — Node keys that directory by tenant, thread, and agent, while
a Cloudflare thread Durable Object owns its own SQLite workspace. Artifact metadata is kept outside
the visible mount, and model writes stay disabled unless the host opts in. Skill bodies and
resources remain progressively loaded content.

> **This is not an Agent Plugin**
>
> The `skills/` directory here looks identical to the one in an
> [Agent Plugin](./plugins.md), and the two are easy to confuse. This folder defines **the agent**
> — its instructions, model, and limits — and is compiled ahead of time into an immutable artifact you
> publish. A plugin defines a **capability bundle someone else published**, carries no model or
> policy, and is loaded at runtime by `loadAgentPlugin`.
>
> Because you author this folder, the compiler rejects a bad build outright. Because you do not author
> a plugin, a broken part of one is isolated rather than fatal. The
> [comparison table](./plugins.md#not-the-same-as-a-file-authored-agent) sets them side by side.
>
> The two compose: an agent authored here can load plugins at runtime, and both supply skills through
> the same `SkillStoreLike`.

> **Caution**
>
> Do not put API keys or other credentials in the agent folder. The compiler rejects recognizable
>   credentials, and the generated artifact must remain safe to store and distribute. Resolve secrets
>   in the host runtime instead.

## Build the immutable Node deployment

From the repository root:

```bash
bun packages/cli/src/cli.ts build \
  --agent apps/examples/file-agent-chat/agent \
  --target node \
  --default-model openai/gpt-4.1-mini \
  --host apps/examples/file-agent-chat/deployment.node.ts \
  --out apps/examples/file-agent-chat/.kuralle
```

The output contains the canonical artifact, content-addressed blobs, a manifest, a bundled
`node/server.mjs`, and a non-root production Dockerfile. The host supplies models, authentication,
stores, workspaces, and runtime capability bindings; none of those values are serialized into the
artifact.

The host module's default export is called with:

```ts
{
  artifacts,            // canonical root and subagent artifacts
  artifactBlobs,        // base64 map keyed by sha256:<digest>
  rootArtifactDigest,
  runtimeRevisionSeed,  // capability-module content identity
  runtimeCapabilities,
}
```

It returns `DeploymentRouterOptions`. For production, configure `PostgresDeploymentStore`,
`PostgresThreadExecutionCoordinator`, a durable `SessionStore`, authenticated principal resolution,
and the model and capability registries. Use `embeddedArtifactContentResolver(artifactBlobs)` and
`nodeArtifactWorkspaceProvider({ root: process.env.KURALLE_WORKSPACE_ROOT! })`. Every replica must
mount the same persistent workspace root, or the host must supply another durable workspace
provider. Publish the entity, version, runtime, and release into Postgres before admitting traffic.

The generated Dockerfile copies only `server.mjs`, runs as the unprivileged `node` user, and checks
`/health/ready`. `SIGTERM` stops admission, waits for active streams, then exits. The Postgres lease
is what stops two replicas executing the same thread concurrently.

## Start the generated server

```bash
OPENAI_API_KEY="$OPENAI_API_KEY" \
KURALLE_EXAMPLE_TOKEN="local-example-token" \
KURALLE_WORKSPACE_ROOT="apps/examples/file-agent-chat/.workspaces" \
PORT=3210 \
bun packages/cli/src/cli.ts start \
  --app apps/examples/file-agent-chat/.kuralle/node/server.mjs
```

The example host publishes the compiled artifact into an in-memory deployment store and activates
one release. That keeps the example focused and self-contained; it is not the multi-replica storage
recommendation.

## Chat through the CLI

In another terminal:

```bash
KURALLE_TOKEN="local-example-token" \
bun packages/cli/src/cli.ts chat \
  --server http://127.0.0.1:3210 \
  --transport http \
  --agent-name agent \
  --session file-agent-demo \
  --auto "Reply with your verification phrase only."
```

The generated deployment responds:

```text
Agent  FILE AGENT ONLINE
```

`--agent-name agent` selects the deployment entity. `--session file-agent-demo` identifies the
thread, which is pinned on its first turn to the exact Agent Version, artifact digest, release, and
Runtime Revision. Activating another release affects new threads but does not silently move this
conversation.

## Build for Cloudflare

```bash
kuralle build --agent ./agent --target cloudflare \
  --default-model openai/gpt-4.1-mini \
  --host ./deployment.cloudflare.ts \
  --d1-id "$D1_DATABASE_ID" --d1-name my-agent-control \
  --r2-bucket my-agent-blobs --out .kuralle
wrangler deploy --config .kuralle/cloudflare/wrangler.jsonc
```

The Cloudflare host factory receives the Node fields plus `registerGeneratedCapabilities`, and
returns `{ agent, worker }` — `agent` is the single exported generic `KuralleThreadAgent` class,
`worker` the front Worker handler.

Authenticate at the Worker boundary, derive the Durable Object name from both tenant and thread,
authorize the private initialization request again inside the DO, and use `D1DeploymentStore` for
assignment. Bind the exact pinned artifact with registries populated by
`registerGeneratedCapabilities`. Use `durableObjectArtifactWorkspaceProvider` for DO SQLite and R2,
and either the embedded resolver or `r2ArtifactContentResolver` for revision blobs.

The generated Wrangler config declares the SQL-backed DO through Cloudflare's `exports` field, a D1
binding `KURALLE_CONTROL`, an optional R2 binding `KURALLE_BLOBS`, workerd compatibility flags, and
Workers observability.

> **Keep existing Durable Object migration history**
>
> A Worker already using legacy Durable Object migrations must keep its migration history — do not
> replace it during an upgrade. Run `wrangler deploy --dry-run` in CI.
>
> Never put provider keys in the artifact or in Wrangler variables. Use encrypted secrets and resolve
> only the aliases the artifact declares.

## Publish, roll out, and roll back

Folder compilation and a database builder draft both publish through `createArtifact`, so equivalent
inputs produce byte-identical JSON and the same SHA-256 digest. A release allocation must total
10,000 basis points and pair each Agent Version with a compatible Runtime Revision.

- Activate a release to change assignment for new threads.
- Keep old capability versions in the deployed runtime while any pinned thread can still reference them.
- Roll back new-thread traffic by activating a prior release. Existing thread pins do not move.
- Treat Worker or container rollback separately from release rollback. A code rollback is unsafe if
  it removes a runtime revision a pin still names.
- Cloudflare DO SQLite migrations are forward operations. Test migration and Worker rollback
  combinations before a production rollout.

## Observe and operate

Every runtime span carries tenant, entity and version, artifact digest, release, runtime revision,
environment and branch, and config and secret generations. Conversation audit events are persisted
in the dedicated audit store and retain an inline crash-safe copy — audit is not inferred from
traces.

Alert on readiness failures, lease renewal failures, binding or content verification failures,
stream errors, DO initialization conflicts, D1 and R2 errors, and drain timeouts. Logs must not
contain prompts, workspace bytes, tool arguments, tokens, or resolved secrets by default. Retain the
build manifest, artifact JSON, runtime bundle digest, migration tag, and release record for every
deployment.

## Move the host to production storage

Replace the example's in-memory deployment/session stores and process-local lease with Postgres
implementations before running multiple replicas. Keep schema changes in your application's existing
migration workflow. See [Agent Definitions in Your Database](./agent-definitions-database.md)
for Postgres, Prisma, Drizzle, Neon, and Cloudflare control-plane patterns.

## Related

- [Agent Plugins](./plugins.md) — third-party capability bundles this agent can load at runtime
- [Skills](./skills.md) — how the `skills/` folder is progressively disclosed
- [CLI](./cli.md) — `kuralle build`, `start`, and `chat`
- [Deployment](./deployment.md) — artifacts, revisions, and thread pinning
- [Agent Definitions in Your Database](./agent-definitions-database.md) — production control plane
