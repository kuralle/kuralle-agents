---
name: kuralle-agents
description: Build, extend, or debug an agent with the Kuralle framework (`@kuralle-agents/*`). Use this skill whenever the task touches `defineAgent`, `defineFlow`, `defineTool`, `createRuntime`, a `*.flow.json` definition, an agent folder compiled by `kuralle build`, a Kuralle skill or plugin, or a Kuralle deployment on Hono, Cloudflare Workers, or Next.js. Trigger it for any mention of Kuralle agents, flows, triage routing, durable tools, effect logs, session stores, agent handoffs, collect/reply/action/decide nodes, or the `kuralle` CLI — and also when the user asks to "build an agent", "add a flow", "add a tool to the bot", "make the bot ask for X first", or "deploy the agent", inside a repository that depends on `@kuralle-agents/core`.
---

# Kuralle agents

Kuralle is a TypeScript framework for conversational AI agents with structured
flows, routing, and durable tool execution. It builds on the Vercel AI SDK, so
you bring your own model provider.

This skill routes you to the right authoring mode, package, and guide. It does
not restate the guides.

## Verify before you write

Do not answer Kuralle questions from memory. The framework moves fast and this
skill goes stale between releases. Use this source order:

1. **`node_modules/@kuralle-agents/core/guides/`** — the guides that ship with
   the installed version. Start at its `README.md`. These match the version the
   project actually runs, so prefer them over anything else when the two differ.
   `rag`, `postgres-store`, `redis-store`, and `tools` ship their own `guides/`
   for package-specific depth.
2. <https://agents.kuralle.com> — the same guides for the latest release. Use
   these when no package is installed yet, or to check what a newer version adds.
   Append `.md` to any page path for its Markdown source —
   `…/guides/observability.md` — which is the cheapest way to read one page.
   (Served by `apps/docs/src/pages/[...slug].md.ts`; live from the first docs
   deploy after commit `9aa6ca7`. If it 404s, the site has not redeployed yet.)
   To read many pages at once, use the generated sets:

   | URL | Size | Contents |
   |---|---|---|
   | `/llms.txt` | ~1 KB | Index of the sets below |
   | `/_llms-txt/guides.txt` | ~270 KB | **All 27 guides.** The one to fetch. |
   | `/_llms-txt/examples.txt` | ~19 KB | Runnable examples and integration labs |
   | `/_llms-txt/api-reference.txt` | ~840 KB | Generated API reference |
   | `/llms-small.txt` | ~1.1 MB | Abridged whole site |
   | `/llms-full.txt` | ~1.3 MB | Whole site |

   Prefer `/_llms-txt/guides.txt` over `llms-full.txt`: same guide content, a
   fifth of the tokens, none of the generated API dump. For a single page,
   prefer `<page>.md` over any of them.

   The served `.md` and the packaged `guides/*.md` come from one transform
   (`apps/docs/src/lib/mdxToMarkdown.ts`) and differ only in link style —
   absolute URLs when served, sibling `./page.md` links when packaged.
3. The package `README.md` — installed at `node_modules/@kuralle-agents/<pkg>/`
   and shown on npm. The fastest answer to "what is this package for".
4. Source and exported types in `packages/core/src/`. Authoritative when a guide
   and the code disagree — report the disagreement rather than picking one.
5. Runnable examples in `packages/core/examples/` and `apps/examples/`. Run one
   before you claim a feature works.
6. `CLAUDE.md` at the repository root for build, test, and release commands.

Inside this monorepo, `packages/core/guides/` is generated from
`apps/docs/src/content/docs/guides/`. Edit the `apps/docs` source, then run
`bun run docs:sync-guides`. `typecheck:all` and publish both fail on a stale copy.

When a claim cannot be verified in the repository, omit it or say the source is
missing. Do not document proposed behavior as shipped.

## Find the page for your task

| To do this | Read this |
|---|---|
| Start a new project from a template | [templates](https://agents.kuralle.com/guides/templates) |
| Write the first working agent | [quickstart](https://agents.kuralle.com/guides/quickstart), then [build-an-agent](https://agents.kuralle.com/guides/build-an-agent) |
| Configure the agent primitive | [agents](https://agents.kuralle.com/guides/agents) |
| Give the agent a callable effect | [tools](https://agents.kuralle.com/guides/tools) |
| Turn a procedure into a node graph | [flows](https://agents.kuralle.com/guides/flows), [flow-execution](https://agents.kuralle.com/guides/flow-execution) |
| Author flows as JSON and register them live | [dynamic-flows](https://agents.kuralle.com/guides/dynamic-flows) |
| Send work to a specialist agent | [routing](https://agents.kuralle.com/guides/routing) |
| Require approval before a tool runs | [policy](https://agents.kuralle.com/guides/policy) |
| Survive a crash mid-turn, or pause for a human | [durable-execution](https://agents.kuralle.com/guides/durable-execution) |
| Persist conversation history | [sessions](https://agents.kuralle.com/guides/sessions) |
| Remember facts across sessions | [memory](https://agents.kuralle.com/guides/memory) |
| Ground answers in documents | [knowledge](https://agents.kuralle.com/guides/knowledge) |
| Package procedural knowledge the agent loads on demand | [skills](https://agents.kuralle.com/guides/skills) |
| Give the agent a filesystem or a shell | [workspace](https://agents.kuralle.com/guides/workspace) |
| Load a third-party capability bundle | [plugins](https://agents.kuralle.com/guides/plugins) |
| Call an MCP server | [mcp](https://agents.kuralle.com/guides/mcp) |
| Accept images, audio, or documents | [multimodal](https://agents.kuralle.com/guides/multimodal) |
| Compile an agent folder into an immutable artifact | [file-authored-agents](https://agents.kuralle.com/guides/file-authored-agents) |
| Store agent definitions in Postgres | [agent-definitions-database](https://agents.kuralle.com/guides/agent-definitions-database) |
| Let end users build agents from a form | [agent-builder-react](https://agents.kuralle.com/guides/agent-builder-react) |
| Build a chat UI, or stream a turn to a browser | [references/clients.md](references/clients.md) |
| Render buttons, approval prompts, or safety notices in a UI | [references/clients.md](references/clients.md) |
| Embed a chat widget on any page | [references/clients.md](references/clients.md) |
| Ship to Node, Bun, Cloudflare, or Vercel | [deployment](https://agents.kuralle.com/guides/deployment) |
| Reach a running agent from a terminal | [cli](https://agents.kuralle.com/guides/cli) |
| Trace a turn, export to OTLP or Langfuse, score an eval | [observability](https://agents.kuralle.com/guides/observability) |
| Reply on WhatsApp, Messenger, or Instagram | [engagement](https://agents.kuralle.com/guides/engagement) |
| Swap the model/tool loop for Pi | [pi-driver](https://agents.kuralle.com/guides/pi-driver) |

## Pick an authoring mode first

Six ways exist to produce a running agent. Picking the wrong one costs a
rewrite, so decide before you write code.

| Mode | Choose it when |
|---|---|
| TypeScript `defineAgent` | You own the repository and deploy code. This is the default. |
| Scaffold from a template | You are starting a new project and want a wired app. |
| Agent folder compiled to an artifact | You need an immutable, content-addressed deployment pinned per thread. |
| JSON `FlowDefinition` | The procedure must change without a code deploy. |
| Database-backed definitions | End users or operators author agents at runtime. |
| Agent Plugin | Someone else published the capability bundle you want to load. |

Read [references/authoring-modes.md](references/authoring-modes.md) for the
concrete shape of each mode and how they compose.

## The smallest agent that runs

```typescript
import { openai } from '@ai-sdk/openai';
import { defineAgent, defineTool, createRuntime } from '@kuralle-agents/core';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by id',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a support agent. Look up orders when asked.',
  model: openai('gpt-4o-mini'),
  tools: { lookupOrder },
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });

const handle = runtime.run({ input: 'Where is order A-91?' });
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.payload.delta);
}
await handle;
```

`defineAgent` is the single agent primitive. Behavior comes from which fields
you populate: add `flows` for a procedure, `routes` plus `routing` for triage,
`agents` plus `handoffs` for composition. There is no separate `FlowAgent` or
`TriageAgent` type.

For exact field lists and signatures, read
[references/api-shapes.md](references/api-shapes.md). For which package supplies
which capability, read [references/packages.md](references/packages.md). For web
UIs, streaming, uploads, and the embeddable widget, read
[references/clients.md](references/clients.md).

## Design rules

These rules come from repeated adversarial testing of the framework. They
explain most review comments on Kuralle code.

**Put the procedure in a flow, not the prompt.** A system prompt carrying more
than about twenty lines of procedure belongs in a `defineFlow` graph. Node
transitions are testable; prompt instructions are not.

**Enforce at the tool boundary, not in the prompt.** Every safety property
enforced by a tool boundary or a typed transition held under testing. Every
property that depended on the model recalling a rule failed. If a rule matters,
make it structural: a `Policy` decision, a `toolScope`, a `collect` schema.

**Tools return data, not conversation.** A tool result is model input, not
user-facing text. The exceptions are the control results `toolDeniedResult` and
`toolErrorResult`, which carry a `message` the model reads to decide what to say
next. Everything the user reads comes from a node or the speaking turn.

**Route silently.** A pure dispatcher classifies by derived shape and never
narrates the transfer. Handoffs are silent by default.

**Promise grounding explicitly.** An agent that must always cite sources sets
`knowledge.autoRetrieve: true`, which pre-injects retrieved snippets. Setting it
to `false` hands the decision to the model.

## Gotchas that cost real time

**Rebuild after editing a package.** Workspace packages import each other's
`dist/`, not `src/`. Edit `packages/core/src/`, then run `bun run build` before
running anything downstream. Skipping this is the most common "my fix did not
take" false negative.

**A bare model string does not reach the provider it names.** `ai@7` resolves
any string through `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway`. So
`model: 'openai/gpt-4.1-mini'` goes to the Vercel AI Gateway and fails on
billing even when `OPENAI_API_KEY` is valid. Pass a configured provider
instance: `createOpenAI({ apiKey })('gpt-4.1-mini')`.

**`handle.events` is a property.** Writing `handle.events()` throws.

**Version and publish every package together.** `pnpm` rewrites `workspace:*` to
the exact dependency version at publish time. Publishing `core` alone leaves
dependents pinned to the old version, and consumers then install two copies of
`core`. All publishable packages sit in one fixed group for this reason.

**Typecheck does not prove a feature is reachable.** `RecoverableToolError`
shipped once exported from nowhere. Run a live example under
`packages/core/examples/` before calling a feature done.

**An app with no `tsconfig.json` is invisible to the type gate.** The
`typecheck:all` sweep reports such apps as `UNSWEPT`. Do not ignore that line.

## Commands

```bash
bun run build            # build all packages, topological
bun run test             # unit tests
bun run typecheck:all    # every framework tsconfig, apps, and lint — the full gate
```

Run `bun install` before `typecheck:all`. A `pnpm` step creates a second copy of
`agents` and the gate then fails on a spurious type mismatch.
