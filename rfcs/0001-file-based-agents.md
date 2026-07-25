# RFC 0001 — File-based agents: project layer, agent layer, and deployment

**Status:** Ready for review · **Date:** 2026-07-25 · **Author:** supervisor session
**Depends on:** ADR-0012 (workspace/shell/FS-skills), ADR-0013 (persistent FileSystem backends)
**Evidence:** [`.understanding/file-based-agents.md`](../.understanding/file-based-agents.md)
**Out of scope:** voice (deleted), channels (RFC 0003), evals (RFC 0004)

---

## 1. Summary

Let a kuralle **project** be defined by files: a `kuralle.config.ts` root, a small set of
default-exporting singletons that assemble `HarnessConfig`, and an `agents/` directory where each
subdirectory assembles one `AgentConfig`. `kuralle build` compiles the tree into a generated module
and deploys unchanged to Node/Bun or Cloudflare Workers/Durable Objects.

The project layer comes **first**, not second: the build cannot start without it. `kuralle.config.ts`
supplies the agents glob, the target, the default model that agents fall back to, and the default
agent id. Everything else in the tree is discovered relative to it.

One capability is unique to kuralle and shapes the format throughout. Because `@kuralle-agents/fs`
provides a `FileSystem` that works *inside* a Durable Object (ADR-0013), the **prose** half of an
agent — instructions, skills, knowledge — can be read at runtime rather than compiled in. A deployed
agent's prompt can change without a redeploy. Flue, Mastra and Eve cannot do this.

---

## 2. Problem

Defining and shipping an agent today is entirely manual, at both layers.

- The only supported entry points are a `Runtime`, an `AgentConfig`, or a factory, resolved by shape
  at runtime via `await import()` (`packages/cli/src/agentLoader.ts:61-79,178`).
- `HarnessConfig` — session store, tracing, compaction, escalation, hooks, retrieval, memory
  (`packages/core/src/runtime/Runtime.ts`) — has no declarative surface at all. Every project
  hand-assembles it.
- Cloudflare means hand-writing a `KuralleAgent` subclass, its `getAgents()`, its DO binding and its
  migration: `apps/playground/pharmacy-rx-agent/src/index.ts:59-80` against `wrangler.jsonc:9-38` —
  three classes, three migration tags, all by hand.
- There is no build step: `kuralle` exposes `chat | send | sim | trace` (`packages/cli/src/cli.ts:68-77`).

Costs:

1. **The floor is too high.** The smallest agent is a TypeScript file with imports, a provider
   client, and a runtime. Eve's floor is one markdown file.
2. **Prose is trapped in code.** Instructions are string literals in `.ts` — not diffable as prose,
   not editable by a non-engineer, not changeable without a redeploy.
3. **No project shape.** Two kuralle codebases share no layout, so nothing is transferable and
   nothing can be scaffolded.
4. **The Cloudflare path is unguarded.** Nothing checks that a DO class name is unique or that
   renaming an agent is a storage-identity change. Getting it wrong silently orphans conversations.

---

## 3. Goals / non-goals

**Goals**

- G1 — `kuralle.config.ts` + `agents/<id>/agent.md` is a complete, runnable project.
- G2 — Every `HarnessConfig` field is reachable from a project file.
- G3 — Every `AgentConfig` field is reachable from an agent file, including flows and routing.
- G4 — One definition deploys to Node/Bun **and** Cloudflare Workers/DO, unmodified.
- G5 — Prose is optionally runtime-mutable on both targets.
- G6 — Identity is validated; a rename that would orphan durable storage fails the build with an
  instruction, not a warning.
- G7 — Zero change to `AgentConfig`, `HarnessConfig`, `Runtime`, or `KuralleAgent`. The build emits
  values those already accept.

**Non-goals**

- **Voice.** Removed from the repo entirely (2026-07-25), not merely out of scope: `realtime-audio`,
  `voice-protocol`, `ws-bench`, `transport-base` and the stale `livekit-plugin*` directories are
  deleted, along with `core/src/realtime`, the `VoiceDriver`, and `cf-agent`'s `./voice` export.
  Kuralle is text-first. Inbound **voice notes** (multimodal audio input + `transcriptionModel`)
  are a separate, retained feature.
- **Channels** (`messaging`, `messaging-meta`, `engagement`) — RFC 0003. The largest remaining gap.
- **Evals** (`@kuralle-agents/eval` scorers, golden manifests) — RFC 0004.
- A GUI or config-service builder. This is files in a repo.
- Replacing code-defined agents. `defineAgent({...})` stays first-class and is what the build emits.
- Hot-reloading *code* on Cloudflare. `workerd` cannot import an arbitrary path at runtime.
- OKF v0.2 conformance — see §13 Q4.

---

## 4. Design

### 4.1 The project layer — this comes first

```
kuralle.config.ts        REQUIRED — the root. Defines the project.
store.ts                 → HarnessConfig.sessionStore
observability.ts         → HarnessConfig.tracing
retrieval.ts             → HarnessConfig.knowledge (KnowledgeProviderConfig)
memory.ts                → HarnessConfig.memoryService + defaultWorkingMemoryStore
hooks.ts                 → HarnessConfig.hooks (`Hooks`, project lifecycle only)
escalation.ts            → HarnessConfig.escalation
compaction.ts            → HarnessConfig.compaction
agents/                  → HarnessConfig.agents
```

```ts
// kuralle.config.ts
import { defineKuralleConfig } from '@kuralle-agents/build';

export default defineKuralleConfig({
  agents: 'agents/*',                  // glob, relative to this file
  defaultAgentId: 'support',
  defaultModel: 'openai/gpt-4.1-mini', // agents omitting `model` inherit this
  target: 'cloudflare',                // 'node' | 'cloudflare'
  out: '.kuralle',
  silentHandoff: true,
  trackGoals: false,
  maxHandoffs: 5,
});
```

`kuralle.config.ts` holds **scalars only**. Anything that is an object or needs a backend is a
singleton file, discovered by filename. Two rules keep this unambiguous:

1. **A singleton counts only if it has a `export default`.** A file with named exports at one of
   these paths is user-managed and ignored. This is Mastra's rule
   (`deployer/src/build/fs-routing/discover.ts` → `discoverFsSingleton`), and it means adopting the
   convention never breaks an existing project that happens to have a `store.ts`.
2. **File presence is the declaration.** The config never lists singletons, exactly as an agent
   directory never lists its tools. One convention, both layers.

### 4.2 The lazy-value contract — one rule, everywhere

`export default new RedisSessionStore({ url: process.env.REDIS_URL })` evaluates at **module scope**.
On `workerd` that runs before `env` exists — so every singleton and every tool that needs a secret
works in Node and breaks on deploy. This is the single most likely way this design fails in
practice, so it is solved once, uniformly:

> **Any default export in this design may be the value, or a function producing it from a context
> carrying `env`.**

```ts
// store.ts — either shape is valid
export default new MemoryStore();
export default ({ env }) => new RedisSessionStore({ url: env.REDIS_URL });
```

```ts
// agents/support/tools/kb.ts — same rule
export default defineTool({ ... });
export default ({ env }) => createCagTool({ apiKey: env.CAG_KEY });
```

The build emits lazy forms as calls inside `getAgents()` / the runtime factory — exactly where the
pharmacy app already resolves `this.env.OPENAI_API_KEY`. `model:` needs no such handling: a string
model resolves through the AI SDK's provider/gateway, which reads the environment itself.

### 4.3 The agent layer

```
agents/
  support/                      ← directory name is the DEFAULT identity
    agent.md                    ← REQUIRED. YAML frontmatter = config; body = instructions
    agent.ts                    ← optional. defineAgentPart({...}) for what YAML can't hold
    tools/*.ts                  ← default export = tool;      filename = tool name
    global-tools/*.ts           ← → globalTools (ADR-0001 base layer — read-only allow-list)
    flows/*.ts                  ← default export = defineFlow(...)
    routes.ts                   ← → routes + routing            (triage agents)
    retrieval.ts                ← → AgentConfig.knowledge       (vector retrieval)
    memory.ts                   ← → AgentConfig.memory
    policies.ts                 ← → AgentConfig.guardrails + refine + validate
    skills/<name>/SKILL.md      ← → skills (already the shipped format)
    knowledge/**/*.md           ← OKF bundle, mounted into the workspace FS (grep/cat, no index)
    workspace/**                ← seed files copied into the workspace at build
    subagents/<id>/             ← recursive → AgentConfig.agents[]
```

A directory is an agent **iff** it contains `agent.md`. One marker, no precedence rule needed.

`policies.ts` is the single agent-level composition point, following ADR-0015. It returns the three
distinct phase contracts together; the runtime keeps their fixed order:

```
guardrails.input → refine → model/tool execution → guardrails.output → validate
```

Project `hooks.ts` remains separate because it configures the operational `HarnessConfig.hooks`
surface around the whole run, not an individual agent. The build targets the actual five-method
`Hooks` contract used by `Runtime`; it does not expose the legacy 19-method `HarnessHooks` facade.
Kuralle deliberately does not copy DeepAgents' middleware-everything model: arbitrary ordering
would turn durable redaction and output-release boundaries into an implicit user convention.

```markdown
---
id: support                     # optional; defaults to the directory name
name: Support
description: Answers billing and account questions.
model: openai/gpt-4.1-mini      # a STRING — valid today, see §4.4
controlModel: openai/gpt-4.1-mini
handoffs: [billing]
limits: { maxTurns: 12 }
guardrails: { blockPii: true }
outOfBandControl: true          # → experimental.outOfBandControl
prose: compiled                 # 'compiled' (default) | 'runtime'
---

You are Aria, a concise support agent for Acme.
Answer in one or two sentences. Use `lookup_order` for any order question.
```

**`knowledge/` vs `retrieval.ts` are different subsystems and deliberately different words.**
`knowledge/**.md` is an OKF bundle mounted into the workspace filesystem — the agent reads it with
`ls`/`cat`/`grep`, no index, no embedder (`packages/fs/src/okf.ts` header states exactly this).
`retrieval.ts` supplies `AgentConfig.knowledge` — vector retrieval, which needs a store. Naming them
both "knowledge" would fuse two mechanisms with different costs.

### 4.4 Why a string model works

In the installed `ai@6.0.193`:

```ts
type LanguageModel = GlobalProviderModelId | LanguageModelV3 | LanguageModelV2;
```

resolved through `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway` (`dist/index.mjs:878`). So
`model: 'openai/gpt-4.1-mini'` already satisfies `AgentConfig.model`
(`packages/core/src/types/agentConfig.ts:28`).

This is load-bearing: **no model-resolver layer is needed**, so G1 costs nothing. `agent.ts` exists
only for values YAML genuinely cannot hold — a configured provider instance, a dynamic
`instructions` function, capability objects.

### 4.5 Precedence — fail loud, don't guess

Mastra picks a winner and warns. kuralle should not: a silently-ignored instruction block is exactly
the class of bug this repo's philosophy forbids.

| Situation | Result |
|---|---|
| Key in `agent.md` only, or `agent.ts` only | used |
| **Same static key in both** | **build error**, naming both files and the key |
| `instructions` as a *function* in `agent.ts` + `agent.md` body | function wins; body passed to it as `ctx.baseInstructions` |
| `tools/foo.ts` and `agent.ts` both define key `foo` | **build error** |
| Agent omits `model`; `kuralle.config.ts` sets `defaultModel` | config value inherited |
| Agent sets `model`; config sets `defaultModel` | agent wins (narrower scope) |

Dynamic instructions is the one legitimate override, because a function is a different capability
from a string — not a duplicate of it. Scalar inheritance from the project config is not a conflict:
narrower scope always wins, and only when the narrower scope actually declares the key.

### 4.6 The filesystem substrate — why this design is available at all

The agent directory and the runtime workspace are the same shape: markdown plus files. The bridge
already ships — `okfBundleToFs` turns a directory of OKF markdown into a live `FileSystem`. This RFC
generalises that move from knowledge to the whole agent.

| Layer | Already shipped | Where |
|---|---|---|
| Portable FS (20 methods) | `FileSystem` | `core/src/types/filesystem.ts` |
| Backends | `InMemoryFs`, `SqlFileSystem` (DO-SQLite / D1 / R2 / Node / Bun), `libsqlHttpBackend`, `CompositeFileSystem` | `packages/fs` |
| Agent reads files | `createFsTool` → the `workspace` tool | `fs/src/tool.ts:198` |
| Skills from the FS | `fsSkillStore(fs)` → `/skills/<n>/SKILL.md` | `fs/src/fs-skill-store.ts:6` |
| Frontmatter parsers | `parseSkillFrontmatter`, `parseOkfConcept` | `packages/fs/src` |
| Knowledge → FS | `okfBundleToFs`, `listOkfConcepts` | `fs/src/okf.ts` |
| workerd-clean root export | shell deliberately at a subpath | `fs/src/index.ts` footer |

Missing: the compiler. That is the whole delta.

The build therefore has **three lanes**:

```
  tools/ global-tools/ flows/ routes.ts *.ts   ── CODE ──► static imports (must compile:
                                                            workerd cannot import() a path)
  agent.md body, skills/**/SKILL.md            ── PROSE ─► inlined  (prose: compiled, default)
                                                        └─► mounted (prose: runtime)
  knowledge/**.md                              ── OKF ───► okfBundleToFs ─┐
  workspace/**                                 ── SEED ──► copied ────────┤
                                                                          ▼
                                                     the agent's FileSystem
                                                     InMemoryFs · SqlFileSystem(DO) · R2
```

With `prose: runtime` the generated config carries no instruction string and no skill bodies;
`instructions` wires to a loader over the agent's `FileSystem` and `skills` to the already-shipped
`fsSkillStore`. On CF that filesystem is `SqlFileSystem` over DO SQLite, so pushing a new `agent.md`
into the DO changes the prompt on the next turn with no deploy.

### 4.7 Identity is durable state

Borrowed from Flue, because they got it right and the failure mode is data loss.

- **Identity** = frontmatter `id`, else the directory name. Pattern `^[a-z0-9]+(-[a-z0-9]+)*$` — the
  shape `parseSkillFrontmatter` already enforces (`fs/src/skill-frontmatter.ts:12`).
- Identity → DO class `Kuralle<Pascal>Agent` and binding `KURALLE_<SNAKE_UPPER>_AGENT`.
- Identity → the DO's storage. **Renaming an agent is a data migration**, and the build says so.

Three fatal validations before any codegen: **duplicate identity**; **folded collision** (two
identities producing the same class or binding name — the fold is lossy, and Flue hit this);
**invalid identity** (fails the pattern, so a generated identifier would be unpredictable).

`kuralle build` never edits `wrangler.jsonc` migration history. It validates that every generated
class has a migration entry and prints the exact JSON to append. Flue's rationale is correct
verbatim: migration history is an ordered, append-only record of deployments; a tool that rewrites
it can destroy the record of what is already live.

---

## 5. Interfaces

New package `@kuralle-agents/build` (Node-only, a devDependency — never shipped to `workerd`), plus
two pure functions in `core` and one loader in `fs`.

```ts
// @kuralle-agents/build — the project root.
export interface KuralleConfig {
  readonly agents?: string;              // glob, default 'agents/*'
  readonly defaultAgentId?: string;      // default: the sole agent, else required
  readonly defaultModel?: string;
  readonly target?: 'node' | 'cloudflare';
  readonly out?: string;                 // default '.kuralle'
  readonly silentHandoff?: boolean;
  readonly trackGoals?: boolean;
  readonly maxHandoffs?: number;
  readonly terminalHandoffTargets?: readonly string[];
}
export function defineKuralleConfig(c: KuralleConfig): KuralleConfig;

/** Value, or a function producing it from env — §4.2. */
export type Lazy<T> = T | ((ctx: { env: Record<string, unknown> }) => T);

export interface DiscoveredProject {
  readonly root: string;
  readonly config: KuralleConfig;
  readonly singletons: Partial<Record<
    'store' | 'observability' | 'retrieval' | 'memory' | 'hooks' | 'escalation' | 'compaction',
    string                                  // absolute path; default-export verified
  >>;
  readonly agents: readonly DiscoveredAgent[];
}

export interface DiscoveredAgent {
  readonly id: string;                     // frontmatter id ?? directory name
  readonly dir: string;                    // absolute, slash-normalised
  readonly agentMdPath: string;
  readonly agentTsPath?: string;
  readonly tools: ReadonlyArray<{ key: string; path: string }>;
  readonly globalTools: ReadonlyArray<{ key: string; path: string }>;
  readonly flows: ReadonlyArray<{ key: string; path: string }>;
  readonly routesPath?: string;
  readonly retrievalPath?: string;
  readonly memoryPath?: string;
  readonly policiesPath?: string;
  readonly skills: ReadonlyArray<{ name: string; skillMdPath: string; references: string[] }>;
  readonly knowledgeDir?: string;          // OKF bundle
  readonly workspaceSeedDir?: string;
  readonly subagents: readonly DiscoveredAgent[];   // depth-capped, §13 Q3
}

export function discoverProject(root: string): Promise<DiscoveredProject>;

// Identity → durable identifiers. Pure; shared by discovery, codegen and the wrangler check.
export function agentClassName(id: string): string;    // 'support' → 'KuralleSupportAgent'
export function agentBindingName(id: string): string;  // 'support' → 'KURALLE_SUPPORT_AGENT'
export function assertAgentIdentities(agents: readonly DiscoveredAgent[]): void;  // fatal
```

```ts
// @kuralle-agents/core — assembly. Pure: callers load the modules and pass them in.
export function assembleAgentConfig(parts: AgentParts): AgentConfig;
export function assembleHarnessConfig(parts: HarnessParts): HarnessConfig;

/** Identity helpers giving editor types to agent.ts, mirroring Mastra's agentConfig(). */
export function defineAgentPart(part: Partial<AgentConfig>): Partial<AgentConfig>;
```

Both assemblers throw `AgentAssemblyError` / `HarnessAssemblyError` on any §4.5 conflict, do no I/O,
and are therefore unit-testable in isolation — the property that makes Mastra's
`assembleAgentFromFsEntry` testable, and the reason to copy its shape.

```ts
// @kuralle-agents/fs — the runtime prose plane (prose: runtime).
export function fsAgentProse(fs: FileSystem, id: string, opts?: { root?: string }): {
  instructions: Instructions;   // a function; re-reads agent.md per turn
  skills: SkillStoreLike;       // delegates to the shipped fsSkillStore
};
```

### 5.1 Build pipeline

```
kuralle build [--target node|cloudflare]

  1  load kuralle.config.ts                       // THE ROOT — nothing proceeds without it
  2  discover singletons                          // default-export check only; no evaluation
  3  discoverAgents(config.agents)                // fs only; sorted; symlinks skipped
  4  assertAgentIdentities(agents)                // duplicate / folded / invalid → fatal
  5  parse each agent.md                          // reuse the frontmatter parser
  6  emit <out>/agents.ts                         // static imports + assembleAgentConfig calls
  7  emit <out>/runtime.ts                        // assembleHarnessConfig + createRuntime
  8  if target=cloudflare:
       emit <out>/worker.ts                       // one KuralleAgent subclass per agent + router
       read wrangler.jsonc (READ-ONLY, never written)
       assert nodejs_compat present
       assert every generated class has a migration entry
       on mismatch: print the exact JSON to append, exit 1
```

Generated `<out>/runtime.ts` (illustrative):

```ts
// GENERATED by `kuralle build` — do not edit.
import { assembleHarnessConfig, createRuntime } from '@kuralle-agents/core';
import store from '../store.js';
import observability from '../observability.js';
import { agents, defaultAgentId } from './agents.js';

export function buildRuntime(env: Record<string, unknown>) {
  return createRuntime(assembleHarnessConfig({
    agents, defaultAgentId,
    defaultModel: 'openai/gpt-4.1-mini',
    silentHandoff: true, trackGoals: false, maxHandoffs: 5,
    sessionStore: typeof store === 'function' ? store({ env }) : store,     // §4.2
    tracing: typeof observability === 'function' ? observability({ env }) : observability,
  }));
}
```

Generated `<out>/worker.ts` for Cloudflare:

```ts
// GENERATED by `kuralle build --target cloudflare` — do not edit.
import { KuralleAgent } from '@kuralle-agents/cf-agent';
import { routeAgentRequest } from 'agents';
import { agents, defaultAgentId } from './agents.js';

export class KuralleSupportAgent extends KuralleAgent<Env> {
  protected getAgents() { return agents; }
  protected getDefaultAgentId() { return defaultAgentId; }
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    routeAgentRequest(req, env, ctx) ?? new Response('Not found', { status: 404 }),
};
```

No new runtime machinery: `KuralleAgent.getAgents()` already returns `HarnessConfig['agents']`
(`cf-agent/src/KuralleAgent.ts:74`), and the pharmacy app already hand-writes this shape.

---

## 6. Deployment strategy

### 6.1 Node / Bun

`kuralle build` then import `<out>/runtime.ts` — directly, or into `@kuralle-agents/hono-server`.
`agentLoader.ts` gains a fourth shape: when `--agent` points at a **directory**, build in memory and
run. So `kuralle chat --agent ./agents/support` needs no build artifact on disk, and
`--agent ./file.ts` and `--agent ./dir/` stay the same command.

### 6.2 Cloudflare Workers / Durable Objects

```
kuralle build --target cloudflare && wrangler deploy
```

- **One DO class per agent** — isolated SQLite storage and durable execution per conversation, the
  model Cloudflare's Agents-platform post describes and Flue implements.
- **Bindings are derived, not authored.** The build prints the `durable_objects.bindings` block
  (§13 Q1 on whether to also emit an overlay).
- **`nodejs_compat` is asserted, not injected** — same reason Flue validates `compatibility_date`
  rather than bumping it: a silent flag change produces confusing runtime failures far from cause.
- **Migrations stay user-authored.** Adding an agent is a triple — directory, build, migration tag:

```jsonc
{ "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["KuralleSupportAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["KuralleBillingAgent"] }
] }
```

  Removing needs `deleted_classes`; changing an `id` needs `renamed_classes`. The build detects both
  by diffing generated classes against migration history and prints the entry to append.
- **Secrets** stay `wrangler secret put`, reached through the §4.2 lazy contract. Frontmatter never
  holds a key.

### 6.3 Runtime prose updates (`prose: runtime`)

The agent's `FileSystem` is `SqlFileSystem` over the DO's SQLite. Writing `/agents/support/agent.md`
into it — via the `workspace` tool, an admin route, or a deploy hook — changes the prompt on the next
turn. Skills work identically because `fsSkillStore` already reads `/skills/<name>/SKILL.md` from any
backend. No new persistence layer; ADR-0013 shipped it.

The governance cost is real and stated: with `prose: runtime` the live prompt is no longer in git.
It is off by default, per-agent, and its writes go through the already-journalled workspace tool.

---

## 7. Validation contract

| # | Check | Gate |
|---|---|---|
| V1 | `kuralle.config.ts` resolution: missing file, bad glob, absent `defaultAgentId` with >1 agent — each a distinct fatal error | `bun test ./packages/build/test` |
| V2 | Singleton discovery: default-export required; a named-export `store.ts` is ignored, not adopted | `bun test ./packages/build/test` |
| V3 | `assembleHarnessConfig` / `assembleAgentConfig`: every §4.5 row, each conflict throwing | `bun test ./packages/core/test` |
| V4 | `discoverAgents`: marker rule, sorted order, symlinks skipped, test files skipped, subagent depth cap | `bun test ./packages/build/test` |
| V5 | Identity: duplicate, folded collision (`issue-triage` vs `IssueTriage`), invalid pattern — three distinct fatal errors | `bun test ./packages/build/test` |
| V6 | **Lazy contract**: a `({env}) => …` store and tool resolve on both targets; module-scope `env` access never appears in generated code | `bun test` + workerd |
| V7 | One-file project (`kuralle.config.ts` + `agent.md`, string model) builds and answers a live turn | `kuralle chat --agent ./examples/file-agents/minimal` |
| V8 | Full project (singletons + tools + flows + routes + skills + subagent) builds; generated config deep-equals a hand-written equivalent | `bun test` |
| V9 | Cloudflare build emits worker + classes; **workerd** integration test runs a turn and persists to DO SQLite | `bun test ./packages/cf-agent/test` (vitest-pool-workers) |
| V10 | Missing migration entry → exit 1 with the JSON to append; missing `nodejs_compat` → exit 1 | build-smoke script |
| V11 | `prose: runtime`: writing a new `agent.md` into the FS changes the next turn's prompt, no rebuild | `bun test` + live CF probe |
| V12 | Live deploy: `wrangler deploy` of the generated worker answers over HTTP and survives a DO eviction | manual, recorded on the task |
| V13 | `bun run typecheck:all`, `bun run build`, `astro build` all exit 0 with the new guide | exit 0 |

V6, V9 and V12 are the ones that actually prove the deployment claim. Per this repo's gotchas, a
typechecking example is not a working example — every generated artifact gets executed.

---

## 8. Work breakdown

Ordered by dependency. The project layer is chunks 1–3 because nothing else can be built first.

| # | Chunk | Done when | Lane |
|---|---|---|---|
| 1 | `@kuralle-agents/build` scaffold; `defineKuralleConfig` + config resolution | V1 green | auto |
| 2 | Singleton discovery (default-export rule) + the `Lazy<T>` contract | V2, V6 green | auto |
| 3 | `assembleHarnessConfig` in core | V3 green | auto |
| 4 | `assembleAgentConfig` + `defineAgentPart` + `AgentAssemblyError` | V3 green | auto |
| 5 | `discoverAgents` (all keys incl. routes/retrieval/memory/policies) | V4 green | auto |
| 6 | Identity helpers + `assertAgentIdentities` | V5 green | auto |
| 7 | `agent.md` frontmatter → `AgentParts` (nested YAML — §13 Q2) | round-trip tests green | auto |
| 8 | Codegen `agents.ts` + `runtime.ts` (static imports, deterministic order) | V8 green | auto |
| 9 | `kuralle build` command + directory support in `agentLoader.ts` | V7 green | approve |
| 10 | Cloudflare target: worker codegen + DO classes | V9 green | **full** — durable identity |
| 11 | wrangler validation: `nodejs_compat`, migration diff, printed JSON | V10 green | **full** |
| 12 | `fsAgentProse` + `prose: runtime` wiring | V11 green | approve |
| 13 | Examples (`minimal`, `full`, `cloudflare`) + `guides/file-based-agents.mdx` + `cli.mdx` | V13 green, examples **executed** | auto |
| 14 | Live CF deploy verification | V12 recorded | approve |

Chunks 3–7 are pure and parallelisable once 1–2 land. Chunks 10–11 are `full` lane: they define
durable storage identity, and getting them wrong orphans production conversations.

---

## 9. Rejected alternatives

**A. Flue's `'use agent'` module directive.** Flue needs it because a Flue agent *is* a function
running hooks — there is no data object to find, so the build must AST-scan for exported functions.
`defineAgent` already returns a plain object (`agentConfig.ts:68`). Adopting a directive adds an
oxc-parser dependency and an AST layer to solve a problem we do not have, and leaves prose in `.ts`.

**B. Runtime directory-walking on both targets.** `workerd` has no filesystem and cannot `import()`
an arbitrary path. Every reference framework binds at build time for this reason. Runtime loading
survives only for the prose plane, where the content is data, not modules.

**C. Singletons named in `kuralle.config.ts` instead of discovered.** Would make the config the only
place to look — but it splits the project into two conventions (config-listed root, file-discovered
agents) for no gain. File presence as declaration is one rule for both layers.

**D. YAML-only, no `agent.ts` escape hatch.** Tempting after §4.4, but turn policies,
retrieval/memory adapters and dynamic instructions are objects and functions. Forcing
them into YAML means inventing a plugin-reference syntax — a config language pretending not to be one.

**E. A Vite plugin, as Flue ships.** Flue can assume Vite; our CF path runs on wrangler's esbuild and
our Node path on `tsc`. A CLI codegen emitting a real, readable file is bundler-agnostic and adds no
dependency. A Vite plugin can wrap this later; the reverse is not true.

**F. Mastra's warn-and-pick precedence.** Rejected in §4.5. A warning that an instruction block was
ignored is a bug report written in advance.

---

## 10. Impact on existing code

Additive. No breaking change.

- `packages/core` — three new exports (`assembleAgentConfig`, `assembleHarnessConfig`,
  `defineAgentPart`). `AgentConfig` and `HarnessConfig` are untouched (G7).
- `packages/cli` — new `build` command; `agentLoader.ts` gains a directory branch beside its three
  existing shapes.
- `packages/fs` — one new export, `fsAgentProse`, composed from the shipped `fsSkillStore`.
- `packages/cf-agent` — **no source change**. The generated worker subclasses `KuralleAgent` and
  implements the two abstract methods it already declares.
- New `packages/build`, Node-only, never bundled into a Worker.

Packages that need no convention because they are libraries referenced from these files:
`commerce` and `tools` (feed `tools/*.ts`), `rag`/`rag-loaders` (feed `retrieval.ts`), and the store
backends `redis-store`/`postgres-store`/`upstash-store`/`vectorize-store`/`lancedb-store` (feed
`store.ts`/`retrieval.ts`/`memory.ts`).

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Identity rename silently orphans DO storage | §4.7 — three fatal validations + migration diff (chunk 11); frontmatter `id` makes a *directory* rename a no-op |
| Secrets at module scope break only on deploy | §4.2 lazy contract, enforced by V6 in workerd — not documentation, a gate |
| Generated code drifts from hand-written agents | V8 asserts deep equality against a hand-written equivalent |
| Symlinked module escapes the project into generated imports | Copy Mastra's discipline exactly: `lstat`, never follow, skip symlinks (`discover.ts:82-108`) |
| Nested subagents recurse without bound | Depth cap with a warning, as Mastra does; §13 Q3 |
| `prose: runtime` makes production prompts un-auditable | Opt-in, per-agent, off by default; writes go through the journalled workspace tool |
| Frontmatter parser is flat-YAML only | Chunk 7 — `limits`/`guardrails` are nested; §13 Q2 |
| Shell is not workerd-clean (`just-bash`) | It is deliberately off the fs root export; the build should reject a CF target whose agent declares scripts, at build time not runtime |

---

## 12. Deferred, with the gap named

Not silently dropped — each is a real capability with no file convention after this RFC:

- **Channels** — `messaging` (`createMessagingRouter`), `messaging-meta` (WhatsApp webhooks),
  `engagement` (`ChannelPolicy`, smart-send strategist). Eve ships `channels/`; Flue ships 17 channel
  packages. Today this means hand-writing what `pharmacy-rx-agent` hand-writes. **RFC 0003** —
  the largest remaining gap.
- **Evals** — `@kuralle-agents/eval` (`Scorer`, golden manifests, transcript replay). Mastra puts
  `scorers/` in the agent directory. **RFC 0004**.
- **Voice** — deleted from the repo, so there is nothing left to give a convention to. See §3.

---

## 13. Open questions

1. **Does `kuralle build` write a wrangler overlay?** Flue merges into the *resolved* config via a
   Vite customizer and never touches the file. Without Vite, our options are print-and-exit-1
   (proposed) or emit `<out>/wrangler.jsonc` for the user to `--config`. Proposed: print first; add
   the overlay only if printing proves annoying in practice.
2. **Flat-YAML or a real parser?** `parseSkillFrontmatter` and `okf.ts` both hand-roll flat YAML;
   `limits`, `guardrails` and `routing` are nested. Proposed: take `yaml` as a dependency of
   `@kuralle-agents/build` only — build-time, never reaches `workerd`.
3. **Subagent depth cap.** Mastra uses 3. We compose via both `agents[]` and `handoffs`, so the tree
   can be wider. Proposed: 3, revisit on a real complaint.
4. **OKF version.** `packages/fs/src/okf.ts` implements v0.1; the spec in
   `GoogleCloudPlatform/knowledge-catalog` is now **v0.2** (provenance, trust tiers, lifecycle,
   attested computation). If `knowledge/` is a headline feature, the upgrade stops being optional.
   Proposed: ship against v0.1 and file the v0.2 upgrade as its own task — a real, separate gap this
   research surfaced.
5. ~~Empty `livekit-plugin*` directories.~~ **Resolved 2026-07-25** — all voice packages
   (`livekit-plugin*`, `transport-base`, `realtime-audio`, `voice-protocol`, `ws-bench`) and their
   wiring were deleted. Kuralle is text-first; §3 non-goals reflect the final state.
