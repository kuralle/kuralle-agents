# Build your first Kuralle agent

You are a coding agent in a user's project folder. Set up **Kuralle** and build
the user's first agent.

Kuralle is a TypeScript framework for conversational AI agents with structured
flows, routing, and durable tool execution. It runs on the Vercel AI SDK, so the
user brings their own model provider. Docs: <https://agents.kuralle.com>.

Read all of this before running anything.

## Rules

- **Never pass a bare model string.** `model: 'openai/gpt-4o-mini'` does not
  reach OpenAI. `ai@7` resolves any string through
  `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway`, so it goes to the Vercel AI
  Gateway and fails with a billing error even when `OPENAI_API_KEY` is valid —
  the provider key is never consulted. Always pass a configured provider
  instance: `createOpenAI({ apiKey })('gpt-4o-mini')`.
- **`handle.events` is a property, not a method.** `handle.events()` throws.
- **A drained event loop is not a successful turn.** A failed turn emits `error`
  parts and still ends with `done`, and the `for await` loop completes without
  throwing. `await handle` is the only place a failure surfaces. Step 4 shows
  the shape.
- **Do not invent API.** Everything you need is in the skill and guides from
  step 1. If you cannot find something there, say so rather than guessing a
  signature.
- **Ask when a choice is real** — what the agent is for, and which provider. If
  the user is unavailable or does not answer, take the default named in step 2,
  say which default you took, and keep going. Do not stall.
- **Stay in this folder.** Do not touch other repositories or global state
  beyond installing packages.
- Requires **Node ≥ 20** or Bun.

## Step 1 — Install the skill, then read the guides

Install the Kuralle skill so you keep the framework's map for this session and
every later one:

```bash
npx skills add kuralle/kuralle-agents --skill kuralle-agents
```

It detects every coding agent configured in this folder and installs to each of
them, so expect `.claude/skills/`, `.agents/skills/`, a `skills-lock.json`, and
possibly more — not a single file. Read the installed `SKILL.md` now: it routes
to every guide, maps the packages, and carries verified signatures.

Read the guides from the site. Every docs page serves its Markdown source by
appending `.md`, so fetch exactly the page you need:

```bash
curl -fsSL https://agents.kuralle.com/guides/quickstart.md | cat
curl -fsSL https://agents.kuralle.com/guides/agents.md | cat
```

Fetch more as the shape demands — `/guides/flows.md` before you write a flow,
`/guides/routing.md` before you write a router, `/guides/tools.md` for tool
options. `https://agents.kuralle.com/_llms-txt/guides.txt` is all 27 guides in
one fetch (~270 KB) when you want the whole picture.

Once installed, `node_modules/@kuralle-agents/core/guides/` also holds guides on
disk. Through 0.23.2 that directory carries an older hand-written set of eight
files; from the next release it is the full 27, generated from the site and
matched to the installed version. Until then, treat the site as authoritative.

## Step 2 — Decide what to build

Ask the user only what you cannot already infer. If they have already decided
something, treat it as binding. If they are unavailable, take the default and
record which one you took.

1. **What should the agent do?** Their answer decides the shape:
   - A conversation with tools it can call → `defineAgent` with `tools`. **This
     is the default.** Start here unless the request clearly needs more.
   - A procedure with ordered steps — collect these fields, confirm, then book
     → add a **flow**. Rule of thumb from the docs: more than about twenty lines
     of procedure in a system prompt belongs in a flow. Read `/guides/flows.md`
     first.
   - **Two different jobs in one product** — for example "check my order" *and*
     "place an order" — is not one agent with both. Build a dispatcher with
     `routes` and `routing`, and give each job its own specialist: the lookup
     gets `tools`, the procedure gets `flows`. Read `/guides/routing.md`.
     Putting a lookup and a flow inside one agent puts a per-turn classifier in
     charge of which one runs; two specialists behind a router is the shape the
     guides work through and the one to reach for.
   - If they are not sure, build the tool-calling agent. Flows and routing are
     added to the same `defineAgent` call later, not migrated to.
2. **Which provider?** `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`,
   or `@ai-sdk/xai`. You need the matching API key in the environment. Default:
   OpenAI with `gpt-4o-mini`.
3. **Where does it run?** A script they run locally is a complete answer — do
   not add a server nobody asked for.
   - Local script → nothing extra. **Default.**
   - HTTP endpoint or a web chat UI → add `@kuralle-agents/hono-server`.
   - Cloudflare Workers → add `@kuralle-agents/cf-agent`.

Restate the result to yourself before writing code:

- Purpose: `<one sentence>`
- Shape: `tools only` / `+ flow` / `router + specialists`
- Provider and model: `<exact specifier>`
- Runs as: `local script` / `hono server` / `cloudflare worker`

## Step 3 — Set up the project

```bash
npm install @kuralle-agents/core ai zod @ai-sdk/openai
```

`npm install` creates a `package.json` for you if the directory is empty. You do
not need `npm init`, a `tsconfig.json`, or `"type": "module"` — the agent in
step 4 runs under `npx tsx` as written.

`ai@^7` and `zod@^4` are peer dependencies, and `@ai-sdk/openai@^4` is the
provider line that pairs with `ai@7`. Keep `zod` on one major across the project
— mixing zod 3 and 4 forks `ai` into duplicate copies and produces `Tool` type
mismatches that are hard to read.

> **`npm create kuralle-agents` is currently broken.** It resolves a template
> tag from the CLI version (`v0.23`) that does not exist in `kuralle/starter`,
> and fails with a 404. Install the packages directly as above.

## Step 4 — Write the agent

Start from this and change it to the user's purpose. Every line is verified
against 0.23.2 — do not embellish it.

```typescript
// agent.ts
import { createOpenAI } from '@ai-sdk/openai';
import { defineAgent, defineTool, createRuntime } from '@kuralle-agents/core';
import { z } from 'zod';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('Set OPENAI_API_KEY before running this.');

const openai = createOpenAI({ apiKey });

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up an order by its id',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a support agent. Look up orders when asked.',
  model: openai('gpt-4o-mini'),
  tools: { lookup_order: lookupOrder },
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });

async function main() {
  const handle = runtime.run({ input: 'Where is order A-91?' });

  for await (const part of handle.events) {
    if (part.type === 'text-delta') process.stdout.write(part.payload.delta);
    if (part.type === 'tool-call') console.log('\n[tool]', part.payload.toolName);
    if (part.type === 'error') console.error('\n[error]', part.payload);
  }

  // The loop above completes even when the turn failed. This is the error
  // boundary — without it a failure is silent.
  await handle;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Two things there are deliberate. The work is inside `async function main()`
rather than at the top level, so the file needs no `"type": "module"` and no
tsconfig. And the record key matches the tool's `name` (`lookup_order`), so
there is never a question of which string other code refers to.

`defineAgent` is the only agent primitive. Behaviour comes from which fields you
populate — add `flows` for a procedure, `routes` plus `routing` for a
dispatcher, `agents` plus `handoffs` for composition. There is no separate
`FlowAgent` or `TriageAgent` type, and nothing to migrate when the agent grows.

If you build a dispatcher: a pure dispatcher declares no `model` of its own, and
the runtime's model gate reads `agent.model ?? defaultModel` — it does not fall
back to `routing.model`. Pass `defaultModel` to `createRuntime`, or every turn
throws before it classifies.

Tools are durable. Every call runs through an append-only effect log, so a
retried turn replays a finished step instead of re-executing it. A crash between
execute and finalize does re-run the effect, so anything with an external side
effect must honour the idempotency key.

## Step 5 — Run it and confirm

The key must be on the command that runs the agent — a separate `export` does
not survive into a new shell:

```bash
OPENAI_API_KEY=sk-... npx tsx agent.ts
```

Do not report success until you have seen the agent stream a reply **and** the
`[tool]` line print. A clean exit is not evidence on its own: `done` fires on
failed turns too.

If it fails:

| Symptom | Cause | Fix |
|---|---|---|
| Billing or gateway error despite a valid key | A bare model string went to the AI Gateway | Pass a provider instance — see Rules |
| `Set OPENAI_API_KEY before running this.` | Key not on the run command | Put it inline, as above |
| `Top-level await is currently not supported` | Work moved out of `main()` | Keep it inside `async function main()` |
| `Runtime requires agent.model or config.defaultModel` | A dispatcher with only `routing.model` | Add `defaultModel` to `createRuntime` |
| `handle.events is not a function` | Called it as a method | It is a property |
| Peer resolution error on install | `ai@6` pinned somewhere | Kuralle 0.23+ needs `ai@^7` |
| `Tool` type mismatches | Two zod majors in the tree | Put the project on one zod version |

## Step 6 — Grow it

Save `payload.sessionId` from the `done` event and pass it back as
`runtime.run({ input, sessionId })` to continue a conversation. The default
session store is in-process; move to Redis or Postgres before a second replica
exists.

Then read the guide for whatever comes next — each is fetchable as `.md`:

| Next step | Guide |
|---|---|
| Turn a procedure into typed steps | `/guides/flows.md` |
| Route between specialists | `/guides/routing.md` |
| Require approval before a tool runs | `/guides/policy.md` |
| Survive a crash, or pause for a human | `/guides/durable-execution.md` |
| Persist conversations | `/guides/sessions.md` |
| Ground answers in documents | `/guides/knowledge.md` |
| Build a web chat UI, or ship it | `/guides/deployment.md` |

The installed skill's decision table covers the rest.
