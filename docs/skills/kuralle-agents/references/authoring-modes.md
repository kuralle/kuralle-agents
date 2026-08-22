# Six ways to author a Kuralle agent

Every mode produces the same thing at runtime: an `AgentConfig` the runtime
executes. They differ in who authors it, when it is fixed, and what happens on a
change. Pick by that, not by taste.

## 1. TypeScript `defineAgent`

The default. You write the agent in code, and the deploy pipeline ships it.

```typescript
import { defineAgent, createRuntime } from '@kuralle-agents/core';

const agent = defineAgent({ id: 'support', instructions: '…', model, tools });
const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });
```

Choose it when you own the repository and a code deploy is an acceptable way to
change behavior. Everything else in this file is a way to relax that last
condition.

Guides: [agents](https://agents.kuralle.com/guides/agents),
[build-an-agent](https://agents.kuralle.com/guides/build-an-agent).

## 2. Scaffold from a template

```bash
npm create kuralle-agents@latest my-app --template nextjs-chatbot
```

`create-kuralle-agents` downloads a template from the public
[`kuralle/starter`](https://github.com/kuralle/starter) repository, pinned to the
`vMAJOR.MINOR` tag matching the CLI version. `nextjs-chatbot` is the first
template: a Next.js chat app with streaming UI, thread history, and a Kuralle
`SessionStore` that uses Postgres when `POSTGRES_URL` is set.

Choose it to start a new project. The output is mode 1 with the wiring done.

Guide: [templates](https://agents.kuralle.com/guides/templates).

## 3. Agent folder compiled to an artifact

Author declarative behavior as a folder, then compile it into an immutable,
content-addressed Agent Artifact.

```text
agent/
  instructions.md        # required
  agent.json             # identity, model, limits — serializable fields only
  flows/refund.flow.json # declarative FlowDefinition graphs
  skills/<name>/SKILL.md # progressively disclosed procedures
  references/            # read-only mount
  workspace/             # seed copied into each thread's private workspace
```

```bash
kuralle build --agent ./agent --target node \
  --default-model openai/gpt-4.1-mini --host ./deployment.node.ts --out ./.kuralle
kuralle start --app ./.kuralle/node/server.mjs
```

Production binds the artifact to a Runtime Revision and pins that exact pair to
each conversation thread. Activating a new release affects new threads only; a
live conversation does not silently move.

The compiler validates each `*.flow.json` strictly and fails the build with the
dotted issue path. It also rejects recognizable credentials, so resolve secrets
in the host runtime instead.

Choose it when a deployment must be reproducible and auditable, and when a
conversation must not change agent version mid-thread.

Guide: [file-authored-agents](https://agents.kuralle.com/guides/file-authored-agents).
Runnable example: `apps/examples/file-agent-chat`.

## 4. JSON `FlowDefinition`

The same node graph as `defineFlow`, expressed as JSON. A declarative predicate
DSL, mapping configs, and `${...}` templates replace the TypeScript callbacks.

Four arrival paths:

| Path | Use |
|---|---|
| `runtime.addDynamicFlows(...)` | Register on a live runtime in process. |
| `FlowDefinitionsStore` | Versioned storage with archive and rollback. |
| `POST /api/stored/flows` | Register over HTTP. Requires policy `stored-flows:write`. |
| `flows/*.flow.json` in an agent folder or plugin | Compiled in ahead of time. |

Rehydrate a stored definition with `rehydrateFlow`. Validate before storing with
`validateFlowDefinition` or `assertValidFlowDefinition`.

A parked flow run pins the flow digest. Redefining a flow under a parked run
raises `FlowDriftError` rather than resuming against a different graph.

Choose it when the procedure must change without a code deploy — an operator
editing a refund policy, or an agent authoring a flow for itself.

Guide: [dynamic-flows](https://agents.kuralle.com/guides/dynamic-flows).

## 5. Database-backed definitions

Store agent definitions in your own database and load them per request. The
`@kuralle-agents/deployment` package supplies canonical agent revisions,
releases, and thread pins. The guide ships a canonical Postgres migration and
adapter patterns for Prisma, Drizzle, Neon, and Cloudflare.

Choose it when end users or operators author agents at runtime, and when you
need a control plane separate from the data plane.

Guides:
[agent-definitions-database](https://agents.kuralle.com/guides/agent-definitions-database),
[agent-builder-react](https://agents.kuralle.com/guides/agent-builder-react)
for the form-to-artifact flow with compare-and-swap and a preview pane.
Runnable example: `apps/examples/agent-builder`.

## 6. Agent Plugin

A capability bundle someone else published, loaded at runtime with
`loadAgentPlugin` from `@kuralle-agents/plugins`. A plugin carries skills, flows,
and MCP servers. It carries no model and no policy.

The plugin `skills/` directory looks identical to the one in a file-authored
agent, and the two are easy to confuse:

| | Agent folder (mode 3) | Agent Plugin |
|---|---|---|
| Defines | The agent: instructions, model, limits | A capability bundle |
| Authored by | You | A third party |
| Bound at | Compile time, immutably | Runtime |
| A broken part | Fails the build outright | Is isolated, not fatal |

They compose. An agent authored in mode 3 can load plugins, and both supply
skills through the same `SkillStoreLike`.

Guide: [plugins](https://agents.kuralle.com/guides/plugins).

## How the modes compose

Modes 1, 2, 3, and 5 are alternatives: each is a way to produce the agent
definition. Modes 4 and 6 are additive — a code-defined agent can register JSON
flows and load plugins at the same time.

A common production shape: mode 5 owns the definition, mode 3 compiles each
revision into an artifact, mode 4 lets operators revise a procedure between
deploys, and mode 6 supplies vendor integrations.
