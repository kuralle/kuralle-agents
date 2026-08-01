# Engineering plan — File-based agents

**Status:** Ready for review · **Date:** 2026-07-28
**Translates:** [`rfcs/0001-file-based-agents.md`](0001-file-based-agents.md) (design) into an implementation contract
**Method:** every claim below was re-verified against source on 2026-07-28. Claims that failed
verification are marked **CORRECTED** or **BLOCKER** and the RFC line that asserted them is named.
**Reference implementation studied:** `vercel/eve` @ `082dfed` (2026-07-28), read from source, not docs.

> This document supersedes the RFC's §5 interfaces, §8 work breakdown and §13 open questions.
> The RFC's §4 design intent survives intact except where marked.

---

## Part 0 — Why this document exists

The RFC is a good design argument. It is not yet a build contract: seven of its source citations
point at files that do not exist, one of its own examples cannot be parsed by the parser it names,
and its Cloudflare target cannot express the only Cloudflare app we actually run in production.

None of those are fatal to the *design*. All of them are fatal to handing the RFC to a worker and
saying "build this".

---

## Part I — What Kuralle actually is today (verified)

### I.1 The three entry shapes, and the one loader

`packages/cli/src/cli.ts` exposes **five** commands — `chat`, `send`, `resume`, `sim`, `trace`.

> **CORRECTED.** RFC §2 states the CLI is `chat | send | sim | trace` citing `cli.ts:68-77`.
> `resume` exists. Minor, but it is the RFC's evidence for "there is no build step", and that
> evidence should be right.

All five route through one call — `resolveBuildRuntime(agentPath, { modelFlag })`
(`cli.ts:67-69`). That function does exactly one thing that matters here:

```ts
// packages/cli/src/agentLoader.ts:177-178
const abs = path.resolve(agentPath);
const mod = await import(pathToFileURL(abs).href);
```

and then duck-types the module's `default` (or a named `runtime` / `agent` / `buildRuntime` /
`build`) export into one of three shapes (`classifyExport`, `agentLoader.ts:61-66`):

| Shape | Discriminator |
|---|---|
| `Runtime` | has `.run()` |
| `AgentConfig` | `id: string` **and** `'instructions' in value`, and not a `Runtime` |
| factory | a plain function (sync only — async factories throw, `agentLoader.ts:181-184`) |

A bare `AgentConfig` is promoted to a `Runtime` by `buildFromAgent` (`agentLoader.ts:126-143`):

```ts
createRuntime({ agents: [agent], defaultAgentId: agent.id, sessionStore, defaultModel, tracing })
```

**The split that decides the whole build design:** the *classification* half
(`resolveModuleExport`, `agentLoader.ts:24-79`) is pure and portable. The *loading* half — one
dynamic `import()` of a CWD-relative path — is what `workerd` cannot do. The plan keeps the first
and replaces the second.

Also Node-locked in the CLI today, and therefore out of scope for a Workers target:
`process.cwd()` (`agentLoader.ts:95`), `node:fs` in `fileStore.ts` / `fileTraceStore.ts`,
`node:http` for `trace --web` (`trace.ts:42-83`), `dotenv` (`resolveModel.ts:9-10`), and Ink's
TTY renderer for `chat` (`chat.tsx:116`).

**One trap for chunk 9.** `resolveCliModel` (`packages/cli/src/resolveModel.ts:13-27`) is
**OpenAI-only** and `process.exit(2)`s without `OPENAI_API_KEY`. RFC §4.4 argues a string model
"just works" through the AI SDK gateway — true of the *type*, false of *this code path*. A
file-based agent whose `agent.md` says `model: anthropic/claude-sonnet-4` and which is run via
`kuralle chat --agent ./agents/support` will not reach the gateway. Fixing that is part of chunk 9,
not an assumption chunk 9 gets to make.

**Confirmed as claimed:** there is no config file, project manifest, or agent-directory notion
anywhere in `packages/cli/src/`. The RFC's "no project shape" problem is real.

### I.2 `AgentConfig` — what can and cannot be YAML

23 fields (`packages/core/src/types/agentConfig.ts:24-73`). `defineAgent` (`:75-77`) is a bare
identity function — no validation, no cloning. **An `AgentConfig` is a live object graph, not
data.** Every "the build emits values the runtime already accepts" statement therefore means
*emitting code*, never emitting JSON.

| Class | Fields |
|---|---|
| **(a) Expressible as YAML** | `id`, `name`, `description`, `handoffs`, `limits`, `experimental.outOfBandControl`, `instructions` (string branch), `model`/`controlModel` (**gateway-string branch only**) |
| **(b) Requires a live TS value** | `tools`, `globalTools` (`.execute` is a closure), `flows`, `agents` (recursive), `validate`, `refine` (class instances), `policy` (`{ decide(req) }`), `workspace` (`FileSystem`/`Shell` object), `knowledge`, `memory` |
| **(c) Branch-dependent** | `instructions` (function / `AgentPrompt` branch), `routes[].filter`, `routing`, `guardrails` (mixes function-bearing `input`/`output` with plain-data `tools`), `skills` (string-path branch is (a); inline/store branches are (b)) |

> Note `AgentConfig.model` is typed `LanguageModel` from `ai`. The gateway-string branch is real,
> but it is a *branch* — a provider instance is equally valid, which is why `agent.ts` must exist.

### I.3 Flows can never be YAML — structural, not stylistic

`CollectNode.onComplete` and `ActionNode.run` are **required function fields**
(`packages/core/src/types/flow.ts:101,109`). `ReplyNode.next` and `DecideNode.decide` are function
transitions (`flow.ts:62-69`). Even the schemas carry closures — `StandardSchemaV1` embeds a
`validate` function (`standard-schema.ts:9-11`). Nodes reference each other by **object identity**;
there is no string-id indirection layer anywhere.

**Verdict: a flow graph cannot be expressed in a data format without inventing a node-reference
layer that does not exist.** `flows/*.ts` staying TypeScript is a structural necessity. RFC G3
("every `AgentConfig` field reachable from an agent file") is true only where "file" means "a `.ts`
file" — the plan states it that way.

### I.4 `HarnessConfig` — and the G2 gap, now precise

22 fields (`Runtime.ts:104-165`). **All 22 are project-level configuration.** Per-turn options live
in a wholly separate `RunOptions` type (`Runtime.ts:167-188`). The constructor snapshots six as
readonly instance fields (`:203-218`); the rest are re-read live from `this.config` on every
`run()` — a lazy-read pattern, not a per-turn-option pattern.

RFC §4.1 gives the project layer seven singleton files plus scalars in `kuralle.config.ts`. Mapping
that against the real 22:

| `HarnessConfig` field | RFC's declarative home |
|---|---|
| `agents`, `defaultAgentId` | `agents/` + config scalar ✅ |
| `sessionStore` | `store.ts` ✅ |
| `tracing` | `observability.ts` ✅ |
| `knowledge` | `retrieval.ts` ✅ |
| `memoryService`, `defaultWorkingMemoryStore` | `memory.ts` ✅ |
| `hooks` | `hooks.ts` ✅ |
| `escalation` | `escalation.ts` ✅ |
| `compaction` | `compaction.ts` ✅ |
| `defaultModel`, `maxHandoffs`, `terminalHandoffTargets`, `silentHandoff`, `trackGoals` | config scalars ✅ |
| **`policy`** | ❌ **none** |
| **`tools`** | ❌ **none** |
| **`handoffInputFilter`** | ❌ **none** |
| **`transcriptionModel`** | ❌ **none** |
| `voiceMode` | ❌ none — and no consumer found; **dead field candidate** |
| `hostClassify` | ❌ none — test seam |
| `hostSelect` | ❌ none — marked `@deprecated` in source (`Runtime.ts:114`) |

> **CORRECTED.** RFC G2 claims "every `HarnessConfig` field is reachable from a project file".
> Four live fields have no home. `policy` is the one that matters: `Policy.decide` is a documented
> safety surface, and while `AgentConfig.policy` overrides it (`Runtime.ts:331,576`), a
> **project-wide default deny** is currently unexpressible in the file layout.

**Plan decision:** add `policy.ts` and `tools.ts` as project singletons; fold
`handoffInputFilter` and `transcriptionModel` into `kuralle.config.ts` as non-scalar exceptions —
or state plainly in the docs that they require a code entry point. Do not restate G2 until it holds.

### I.5 The filesystem substrate — and seven wrong citations

The substrate is real and better than the RFC describes. The RFC's *pointers to it* are wrong.

> **CORRECTED — this is the most mechanical defect in the RFC.** RFC §4.6 / §4.7 / §5 and the
> companion investigation cite `packages/fs/src/skill-frontmatter.ts` and
> `packages/fs/src/fs-skill-store.ts`. **Neither file exists.** Both live in **core**:
> `packages/core/src/skills/parseSkillFrontmatter.ts:14` and
> `packages/core/src/skills/fsSkillStore.ts:14`. Core also owns the `FileSystem` type
> (`packages/core/src/types/filesystem.ts`).

This is not cosmetic — it inverts the RFC's package layering. RFC §5 places `fsAgentProse` in
`@kuralle-agents/fs`, "composed from the shipped `fsSkillStore`". That would make `fs` depend on
`core`'s skill internals to build a thing whose only real dependency is the `FileSystem` *type*,
which core already owns.

**Plan decision:** `fsAgentProse` ships in **`@kuralle-agents/core`**, beside `fsSkillStore`.
`@kuralle-agents/fs` stays what it is — backends only.

What the substrate actually provides (`packages/fs/package.json` export map, verified):

| Export | Contents | Workers-clean |
|---|---|---|
| `.` | fs primitives, `InMemoryFs`, `CompositeFileSystem`, `sqlFileSystem`, `r2BlobStore`, OKF | ✅ yes |
| `./shell` | `virtualShell()` over `just-bash` | ❌ **no** — pulls `turndown` (ADR-0012 §B) |
| `./node` | `nodeSqlFileSystem`, `nodeShell` | ❌ Node-only |
| `./cloudflare` | `cloudflareShell` (Sandbox DO wrapper) | ✅ CF-only |

`fsSkillStore(fs, orderedRoots = ['/skills'])` (`fsSkillStore.ts:14`) walks each root for
`<dir>/SKILL.md`, later roots overriding earlier by frontmatter `name`
(`skills.set(parsed.name, …)`, `:91`). Two behaviours the RFC does not account for:

- **No caching whatsoever.** `list()`, `loadBody()` and `loadResource()` each call
  `discoverSkills()`, which re-reads and re-parses every `SKILL.md` from the backing store
  (`:60-108`). On DO SQLite with `prose: runtime`, that is a full re-scan per call, not per turn.
- **Malformed skills are swallowed.** A parse failure is `console.warn` + skip during `list()`, and
  a silent skip during `load*()` (`:97-103`). That is the exact "silently ignored" behaviour RFC
  §4.5 forbids — acceptable at runtime, **not** acceptable at build time. The build must parse
  skills itself and fail loud.

### I.6 BLOCKER — the frontmatter parser cannot parse the RFC's own example

RFC §13 Q2 files this as an open question ("flat-YAML or a real parser?"). It is not a question. It
is a blocker, and the failure mode is worse than the RFC assumes.

`parseFlatYaml` (`packages/core/src/skills/parseSkillFrontmatter.ts:57-124`) supports exactly four
shapes: scalars, inline flow arrays `key: [a, b]`, block sequences `key:\n  - a`, and **a
hardcoded special case for one key literally named `metadata`** (`:93-104`).

Trace the RFC's own sample `agent.md` (§4.3) through it:

| Line in the RFC's example | Result |
|---|---|
| `model: openai/gpt-4.1-mini` | ✅ string `"openai/gpt-4.1-mini"` |
| `handoffs: [billing]` | ✅ `["billing"]` |
| `limits: { maxTurns: 12 }` | 🔴 **silently becomes the string `"{ maxTurns: 12 }"`** |
| `guardrails: { blockPii: true }` | 🔴 **silently becomes a string** |
| `outOfBandControl: true` | 🟠 **string `"true"`, not boolean** |

Inline flow *mappings* never match the `[`…`]` branch (`:109`), so they fall through to
`parseScalar` (`:126-135`), which returns the raw text. And the block form is worse:

```yaml
limits:
  maxTurns: 12
```

`rest` is empty → the next line is neither a `- ` item nor under key `metadata` → `limits` is set
to `''` and the loop **re-enters on the indented line**, which fails the key regex (`:69`) and
**throws** `invalid YAML frontmatter near line`.

`parseScalar` also returns **only strings** — never booleans or numbers. So even the flat scalars
the RFC relies on (`maxHandoffs: 5`, `outOfBandControl: true`) are type-lossy.

**Verdict:** two of the five config lines in the RFC's flagship example produce garbage silently,
one produces the wrong type, and the block alternative throws. Chunk 7 is not "nested YAML support"
— it is a precondition for the format existing at all.

### I.7 The Cloudflare path — and the app the RFC's codegen cannot express

`KuralleAgent<Env, State>` (`packages/cf-agent/src/KuralleAgent.ts:66`) extends CF's **external**
`AIChatAgent` from `@cloudflare/ai-chat` (`^0.8.4`, not vendored). Two abstract methods:
`getAgents()` (`:75`) and `getDefaultAgentId()` (`:80`). `buildRuntime()` (`:198`) reconstructs the
runtime **per request**, and secrets reach it only because the subclass's own `getAgents()` reads
`this.env.<SECRET>` inline. There is no framework-level env→config bridge — which is precisely why
RFC §4.2's `Lazy<T>` contract has to exist.

Session state is **split across two stores**: CF's native `AIChatAgent` table owns messages, while a
bespoke `OrchestrationStore` SQL table (keyed by `sessionId`, CAS-versioned) owns Kuralle's
agent/flow/handoff state, bridged by `BridgeSessionStore`. The RFC never mentions this; generated
code must reproduce it (it comes free by subclassing, but it constrains what "one DO class per
agent" can mean).

> **BLOCKER.** The real deployed app — `apps/playground/pharmacy-rx-agent` — needs **three DO
> classes, and only one of them extends `KuralleAgent`.** `PharmacyWaAgent` is a raw CF
> `DurableObject` hand-wired through `createDurableObjectInboundRuntime` + `createSqlExecutor` and
> the `@kuralle-agents/messaging` inbound pipeline. It is a structurally different, non-reducible
> second path.
>
> RFC §5.1 emits exactly one `KuralleAgent` subclass per agent directory. **The generated worker
> therefore cannot express our own flagship Cloudflare deployment.** The channels deferral (§12 →
> RFC 0003) is not a deferral; it is a hard dependency of the CF target.

**Plan decision:** `kuralle build --target cloudflare` **fails loud** with a named reason when a
project declares a channel, until RFC 0003 lands. Emitting a worker that silently cannot serve the
app's real traffic is worse than refusing to emit one.

**One RFC claim fully validated, and it is the load-bearing one.** DO-SQLite-backed `FileSystem` is
not a test fixture: `apps/playground/fs-demo-cf/src/index.ts:28-53` wires
`sqlFileSystem(this.ctx.storage.sql)` into a live-deployed worker. `prose: runtime` rests on shipped
ground.

Nothing in the repo validates DO class-name or binding uniqueness today — delegated entirely to
Wrangler at deploy time. The RFC's §4.7 gap is real. And the only existing scaffolding,
`packages/create-kuralle-agents`, downloads a static template repo via `giget`; there is **no
codegen anywhere in this monorepo** to extend.

---

## Part II — What Eve teaches (verified from source @ `082dfed`)

### II.1 Where Eve confirms our design

- **Build-time binding, proven.** Eve's walker (`discover/project.ts:52`) runs at exactly three
  moments: `eve build`, `eve dev` boot, and the dev watcher. The layer that serves chat turns
  (`runtime/sessions/compiled-agent-cache.ts`) never calls discovery. RFC §9-B ("runtime
  directory-walking") is correctly rejected.
- **Discovery never imports authored code.** `discoverAgent`'s own doc comment says so
  (`discover/discover-agent.ts:87`); it uses only `stat`/`readdir`/`readFile` behind a
  `ProjectSource` abstraction. Same as Mastra. Adopt without modification.
- **Hard-fail precedence.** Slot collisions, module collisions and skill-id collisions are all
  `severity: error` and gate the build; a runtime `RuntimeRegistry` throws on any duplicate or
  reserved name. Exactly RFC §4.5's posture, in a shipped system. The **sole** exception is
  extension-mount overrides (`dedupeBy`, primary-wins).
- **Determinism and safety in the walk.** Symlinks classified as `"other"` and ignored
  (`discover/project-source.ts:25`; the watcher also sets `followSymlinks: false`); directory order
  forced through a `localeCompare` sort (`discover/grammar.ts:176`). Copy both.

### II.2 The artifact shape to copy

Eve emits **two** generated files:

1. `.eve/compile/module-map.mjs` (`compiler/module-map.ts:65`) — static
   `import * as module_N from "…"` lines plus a frozen `nodeId → sourceId → binding` table, headed
   with a do-not-edit banner.
2. A self-installing bootstrap (`internal/application/compiled-artifacts.ts:200`) that inlines that
   map plus the full manifest as JSON literals and installs it on import — so the bundler traces it
   into the production bundle.

**That second artifact is the workerd-safe shape we need**: static imports, inlined literals, no
`node:fs` on the served path. Our `<out>/agents.ts` should be emitter #1 and `<out>/worker.ts`
emitter #2.

Eve then resolves the map into tool/hook/channel registries cached per session under a
version-hashed key (`runtime/cache-key.ts:15`) that invalidates on `sourceGraphHash`/mtime change.
Given `fsSkillStore` has no cache at all (§I.5), we need the equivalent for `prose: runtime`.

### II.3 Where Eve chose differently — the five forks

Each of these is a decision the plan must *argue*, not inherit.

**Fork 1 — Eve has no root config file.** No `eve.config.*`. Config lives in `agent/agent.ts` via
`defineAgent`, plus a few `package.json` keys. Our RFC §4.1 makes `kuralle.config.ts` **required**
and "first".

**Ruling: keep ours.** Eve has no `HarnessConfig` analogue — no session store, no tracing config, no
compaction, no escalation to declare. We have 22 project-level fields (§I.4). They need a home, and
scattering them across the first agent directory would be worse. But the RFC's justification
("the build cannot start without it") is circular; the real justification is §I.4 and it should say so.

**Fork 2 — Eve's instructions file has zero frontmatter.** A `---` block at the top of the
instructions markdown is literal prompt text. Config is `agent.ts`; prose is markdown; they never
mix. (Skills *do* parse frontmatter, so this is deliberate.)

This is the deepest fork. Fusing config into the prose file is what buys our one-file floor — and it
is exactly what creates the `prose: runtime` silent-ignore hazard: edit frontmatter in a live
`agent.md` and nothing happens, because config was compiled in.

**Ruling: keep the fusion, kill the hazard.** See §III.2 — the frontmatter-hash guard makes the
silent case impossible without giving up one-file authoring.

**Fork 3 — Eve's identity is 100% path-derived, and authoring an `id` throws.** Every `define*`
normalizer rejects a `name`/`id` key outright, to hold one source of truth.

**Ruling: keep frontmatter `id`, with the argument stated.** For Eve, identity is a label. For us,
identity → DO class name → **durable storage**. Without a frontmatter `id`, renaming a *directory*
becomes a data migration — a filesystem operation that silently orphans production conversations.
The second source of truth is the price of decoupling storage identity from a directory name, and
§4.7's three validations are what keep it honest. State this in the docs; it is not self-evident.

**Fork 4 — Eve has no agent marker file.** It matches slot directory names against a hardcoded
classifier and only *warns* on unrecognized directories.

**Ruling: ours is better.** `agent.md` as the sole marker is one rule with no ambiguity. Keep it, and
note that unrecognized directories inside an agent should be an **error**, not a warning — a typo'd
`tool/` (singular) silently contributing nothing is precisely the class of bug §4.5 exists to stop.

**Fork 5 — Eve validates charsets for tools, connections, channels, hooks and extensions before
loading, but not for skill ids or subagent ids.** An emoji-named skill directory passes discovery.

**Ruling: close the gap they left open.** `assertAgentIdentities` must cover skills and subagents,
not just agents.

### II.4 What to steal outright

- **Namespacing by construction.** Eve names contributed tools `<connection>__<tool>` and
  `<extension>__<thing>`, so collisions cannot arise. Cheaper than detecting them.
- **Path-flattening for tool names.** `tools/billing/refund.ts` → `billing-refund`, because
  providers reject `/`. Our RFC's flat `tools/*.ts` never says what a subdirectory does. This does.
- **Diagnostics as data.** Eve accumulates typed diagnostics (`DISCOVER_SKILL_FRONTMATTER_INVALID`
  and friends) with severities rather than throwing on the first problem, then gates the build on
  any `error`. One run reports every problem — far better DX than fail-on-first.

### II.5 What to reject

**Eve's durability model.** There is no per-tool effect log and no idempotency key. Tool execution
lives inside the same `"use step"` as the model call that requested it
(`stopWhen: isStepCount(1)`, `harness/tool-loop.ts:907`), so a crash mid-tool re-runs the whole step
— re-issuing the model call and re-executing whatever tools the *new* response asks for. Their docs
put that on the tool author.

Kuralle's durable executor with an effect log and idempotency key — plus ADR-0012's `replay: false`
making fs/shell honestly at-least-once — is **strictly stronger at the tool boundary**. Do not
regress toward Eve here.

Worth a separate look, though: Eve's **turn-level** exactly-once. Their per-turn workflow claims a
deterministic hook token and a duplicate retry hits `HookConflictError` and exits as a no-op before
doing any work (`execution/turn-workflow.ts:64-93`). We carry `idempotencyKey` in `RunOptions`;
whether it is *enforced* that way is unverified and out of scope for this plan.

**Eve's env model.** Tools read `process.env.X` inline; the only lazy path is connections'
`getToken()`. That works because Eve runs on Node. On `workerd` there is no module-scope `env`, so
we get no reference implementation for §4.2 — `Lazy<T>` is ours to design and ours to test.

---

## Part III — Revised design

### III.1 Package layering (corrected)

```
@kuralle-agents/build     NEW. Node-only devDependency. Never bundled into a Worker.
                          discovery · identity · frontmatter · codegen · wrangler validation
@kuralle-agents/core      + assembleAgentConfig, assembleHarnessConfig, defineAgentPart
                          + fsAgentProse   ← moved here from `fs` (§I.5)
@kuralle-agents/cli       + `build` command; directory branch in agentLoader
@kuralle-agents/fs        unchanged — backends only
@kuralle-agents/cf-agent  unchanged
```

### III.2 The `agent.md` contract — one file, no silent config

Three rules, which together resolve §I.6 and Fork 2:

1. **Frontmatter is parsed at build time by a real YAML parser.** `@kuralle-agents/build` takes
   `yaml` as a dependency. It is a devDependency of the user's project and never reaches `workerd`.
   `parseSkillFrontmatter` is **not** reused — it is a skill-interop format (requires
   `name`+`description`, enforces the agentskills charset, bans reserved vendor words) and is left
   untouched.
2. **The runtime prose plane reads only the body.** `fsAgentProse` never interprets frontmatter.
3. **The compiled artifact carries a frontmatter hash, and the runtime loader enforces it.** If a
   `prose: runtime` agent's live `agent.md` has frontmatter that differs from what was compiled, the
   turn **fails loud** with an instruction to rebuild — instead of silently serving stale config.

```ts
// packages/build/src/agent-md.ts
import { parse as parseYaml } from 'yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;

export interface ParsedAgentMd {
  readonly frontmatter: Record<string, unknown>;
  readonly frontmatterHash: string;
  readonly body: string;
}

export function parseAgentMd(content: string, path: string): ParsedAgentMd {
  const stripped = content.replace(/^﻿/, '');
  const match = stripped.match(FRONTMATTER_RE);
  if (!match) {
    throw new BuildError('AGENT_MD_NO_FRONTMATTER', path,
      'agent.md must open with a "---" frontmatter block declaring at least `id` or rely on the directory name.');
  }
  const raw: unknown = parseYaml(match[1] ?? '');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BuildError('AGENT_MD_FRONTMATTER_NOT_A_MAP', path, 'Frontmatter must be a YAML mapping.');
  }
  let body = match[2] ?? '';
  if (body.startsWith('\n')) body = body.slice(1);

  return {
    frontmatter: raw as Record<string, unknown>,
    frontmatterHash: fnv1a(match[1] ?? ''),
    body,
  };
}

/** Detects an accidental edit, not an adversarial one: a caller who can write the file
 *  cannot change compiled config anyway, so a collision hides nothing that matters. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
```

Frontmatter is then validated against a schema rather than trusted — the same discipline the rest of
the framework applies to model output:

```ts
// packages/build/src/agent-frontmatter-schema.ts
import { z } from 'zod';

export const AgentFrontmatter = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),          // gateway id only; a provider instance goes in agent.ts
  controlModel: z.string().optional(),
  handoffs: z.array(z.string()).optional(),
  limits: z.object({ maxTurns: z.number().int().positive().optional() }).partial().optional(),
  guardrails: z.object({ blockPii: z.boolean().optional() }).passthrough().optional(),
  outOfBandControl: z.boolean().optional(),
  prose: z.enum(['compiled', 'runtime']).default('compiled'),
}).strict();   // an unknown key is an ERROR, not an ignored field
```

`.strict()` is deliberate. A typo'd `hand0ffs:` must fail the build, not vanish.

### III.3 Discovery — filesystem only, diagnostics as data

```ts
// packages/build/src/discover.ts
export type Severity = 'error' | 'warning';
export interface Diagnostic {
  readonly code: string;          // 'DISCOVER_DUPLICATE_IDENTITY', …
  readonly severity: Severity;
  readonly path: string;
  readonly message: string;
}

export interface DiscoveryResult {
  readonly project: DiscoveredProject;
  readonly diagnostics: readonly Diagnostic[];
}

export async function discoverProject(root: string): Promise<DiscoveryResult>;
```

Accumulate, then gate — one run reports every problem (Eve's model, §II.4):

```ts
const { project, diagnostics } = await discoverProject(root);
const errors = diagnostics.filter((d) => d.severity === 'error');
if (errors.length > 0) {
  for (const d of diagnostics) reportDiagnostic(d);
  process.exit(1);
}
```

The directory walk, with Mastra's and Eve's hardening made explicit:

```ts
async function walkAgentDir(dir: string, diags: Diagnostic[]): Promise<DiscoveredAgent | null> {
  if (!(await isFile(join(dir, 'agent.md')))) return null;   // the sole marker

  const entries = (await readdir(dir, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name));           // deterministic codegen

  for (const e of entries) {
    // lstat, never follow: a symlinked module could point anywhere on the build machine
    // and be embedded into generated import code.
    if (e.isSymbolicLink()) {
      diags.push({ code: 'DISCOVER_SYMLINK_SKIPPED', severity: 'warning',
                   path: join(dir, e.name), message: 'Symlinks are not followed.' });
      continue;
    }
    if (e.isDirectory() && !KNOWN_SLOTS.has(e.name)) {
      // Eve warns here; we error (Fork 4) — a typo'd `tool/` must not silently contribute nothing.
      diags.push({ code: 'DISCOVER_UNKNOWN_SLOT', severity: 'error',
                   path: join(dir, e.name),
                   message: `Unknown directory "${e.name}". Known slots: ${[...KNOWN_SLOTS].join(', ')}.` });
    }
  }
  …
}
```

**Tool keys flatten nested paths** (Eve's rule, §II.4), and test files are excluded by pattern
rather than left to fail a name regex:

```ts
const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/;

/** tools/billing/refund.ts → 'billing-refund' — providers reject '/' in tool names. */
function toolKeyFromPath(rel: string): string {
  return rel.replace(/\.[cm]?tsx?$/, '').split('/').join('-');
}
```

**Singleton detection without evaluating the module.** Discovery must not `import()`, so the
default-export check is a source-text heuristic — and the plan says so rather than pretending
otherwise. The authoritative check is the compile step: the generated module imports the singleton,
and if there is no default export, `tsc`/the bundler fails with a precise error.

```ts
const HAS_DEFAULT_EXPORT = /^\s*export\s+default\s|^\s*export\s*\{[^}]*\bas\s+default\b/m;

async function isSingleton(path: string): Promise<boolean> {
  return HAS_DEFAULT_EXPORT.test(await readFile(path, 'utf8'));
}
```

### III.4 Identity — durable, validated, one helper shared by three consumers

```ts
// packages/build/src/identity.ts
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;   // same shape parseSkillFrontmatter enforces

export function agentClassName(id: string): string {
  return `Kuralle${id.split('-').map((s) => s[0]!.toUpperCase() + s.slice(1)).join('')}Agent`;
}
export function agentBindingName(id: string): string {
  return `KURALLE_${id.replace(/-/g, '_').toUpperCase()}_AGENT`;
}

export function assertAgentIdentities(agents: readonly DiscoveredAgent[], diags: Diagnostic[]): void {
  const byId = new Map<string, string>();
  const byClass = new Map<string, string>();

  for (const a of agents) {
    if (!ID_PATTERN.test(a.id)) {
      diags.push({ code: 'IDENTITY_INVALID', severity: 'error', path: a.dir,
        message: `Agent id "${a.id}" must match ${ID_PATTERN}. Identity becomes a Durable Object class name.` });
      continue;
    }
    const prior = byId.get(a.id);
    if (prior) {
      diags.push({ code: 'IDENTITY_DUPLICATE', severity: 'error', path: a.dir,
        message: `Agent id "${a.id}" is also declared by ${prior}.` });
    }
    byId.set(a.id, a.dir);

    // The fold to a class name is lossy — 'issue-triage' and 'issuetriage' collide.
    const cls = agentClassName(a.id);
    const clsPrior = byClass.get(cls);
    if (clsPrior && clsPrior !== a.dir) {
      diags.push({ code: 'IDENTITY_FOLDED_COLLISION', severity: 'error', path: a.dir,
        message: `Agents "${a.id}" and "${byId.get(clsPrior)}" both generate class ${cls}. ` +
                 `Rename one — the class name is its durable storage identity.` });
    }
    byClass.set(cls, a.dir);

    // Fork 5: Eve leaves skills and subagents unvalidated. We do not.
    for (const s of a.skills) if (!ID_PATTERN.test(s.name)) { /* SKILL_ID_INVALID */ }
    assertAgentIdentities(a.subagents, diags);
  }
}
```

### III.5 Assembly — pure, in core, fail-loud precedence

```ts
// packages/core/src/build/assemble.ts
export interface AgentParts {
  readonly id: string;
  readonly fromMarkdown: Partial<AgentConfig>;           // typed frontmatter + body → instructions
  readonly fromModule?: Partial<AgentConfig>;            // agent.ts default export
  readonly tools?: Record<string, AnyTool>;
  readonly globalTools?: Record<string, AnyTool>;
  readonly flows?: Flow[];
  readonly agents?: AgentConfig[];
  readonly defaults?: { model?: LanguageModel };         // from kuralle.config.ts
}

export class AgentAssemblyError extends Error {
  constructor(readonly code: string, readonly agentId: string, message: string) { super(message); }
}

export function assembleAgentConfig(parts: AgentParts): AgentConfig {
  const md = parts.fromMarkdown;
  const ts = parts.fromModule ?? {};

  for (const key of Object.keys(ts) as (keyof AgentConfig)[]) {
    if (!(key in md)) continue;
    // Dynamic instructions is the one legitimate override: a function is a different
    // capability from a string, not a duplicate of it (RFC §4.5).
    if (key === 'instructions' && typeof ts.instructions === 'function') continue;
    throw new AgentAssemblyError('AGENT_KEY_CONFLICT', parts.id,
      `"${key}" is declared in both agent.md and agent.ts. Remove one — the build will not guess.`);
  }

  const toolConflict = Object.keys(parts.tools ?? {}).find((k) => k in (ts.tools ?? {}));
  if (toolConflict) {
    throw new AgentAssemblyError('TOOL_KEY_CONFLICT', parts.id,
      `Tool "${toolConflict}" is defined by both tools/${toolConflict}.ts and agent.ts.`);
  }

  const instructions =
    typeof ts.instructions === 'function'
      ? wrapWithBaseInstructions(ts.instructions, md.instructions as string | undefined)
      : (md.instructions ?? ts.instructions);

  return {
    ...md, ...ts,
    id: parts.id,
    instructions,
    // narrower scope wins, and only when it actually declares the key
    model: md.model ?? ts.model ?? parts.defaults?.model,
    ...(parts.tools ? { tools: { ...parts.tools, ...ts.tools } } : {}),
    ...(parts.flows ? { flows: parts.flows } : {}),
    ...(parts.agents ? { agents: parts.agents } : {}),
  };
}
```

No I/O, no filesystem — every §4.5 row is a unit test.

### III.6 Codegen — emitter #1, static imports

```ts
// GENERATED by `kuralle build` — do not edit.
import { assembleAgentConfig } from '@kuralle-agents/core';

import agentSupportMod from '../agents/support/agent.js';
import toolSupportLookupOrder from '../agents/support/tools/lookup-order.js';
import flowSupportRefund from '../agents/support/flows/refund.js';

const SUPPORT_INSTRUCTIONS =
  "You are Aria, a concise support agent for Acme.\n" +
  "Answer in one or two sentences. Use `lookup_order` for any order question.\n";

export function buildAgents(env: Record<string, unknown>) {
  const support = assembleAgentConfig({
    id: 'support',
    fromMarkdown: {
      name: 'Support',
      description: 'Answers billing and account questions.',
      model: 'openai/gpt-4.1-mini',
      handoffs: ['billing'],
      limits: { maxTurns: 12 },              // a real number — parsed by `yaml` at build time
      experimental: { outOfBandControl: true },
      instructions: SUPPORT_INSTRUCTIONS,
    },
    fromModule: agentSupportMod,
    // §4.2 lazy contract: resolved HERE, inside a function that receives env —
    // never at module scope, which on workerd runs before `env` exists.
    tools: {
      'lookup-order': typeof toolSupportLookupOrder === 'function'
        ? toolSupportLookupOrder({ env })
        : toolSupportLookupOrder,
    },
    flows: [flowSupportRefund],
  });

  return [support];
}

export const defaultAgentId = 'support';
export const proseManifest = {
  support: { mode: 'compiled' as const, frontmatterHash: '9a3f21c7' },
};
```

### III.7 Codegen — emitter #2, the Cloudflare worker

Matches the verified `KuralleAgent` contract (`getAgents` / `getDefaultAgentId`), and refuses to
emit when a channel is declared (§I.7):

```ts
// GENERATED by `kuralle build --target cloudflare` — do not edit.
import { KuralleAgent } from '@kuralle-agents/cf-agent';
import { routeAgentRequest } from 'agents';
import { buildAgents, defaultAgentId } from './agents.js';

export class KuralleSupportAgent extends KuralleAgent<Env> {
  protected getAgents() { return buildAgents(this.env as Record<string, unknown>); }
  protected getDefaultAgentId() { return defaultAgentId; }
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
    routeAgentRequest(req, env, ctx) ?? new Response('Not found', { status: 404 }),
};
```

Wrangler stays **read-only**, as RFC §4.7 requires:

```ts
export function assertWranglerContract(cfg: WranglerConfig, classes: string[], diags: Diagnostic[]) {
  if (!cfg.compatibility_flags?.includes('nodejs_compat')) {
    diags.push({ code: 'WRANGLER_MISSING_NODEJS_COMPAT', severity: 'error', path: cfg.__path,
      message: 'Add "nodejs_compat" to compatibility_flags.' });
  }
  const declared = new Set(cfg.migrations?.flatMap((m) => m.new_sqlite_classes ?? []) ?? []);
  const missing = classes.filter((c) => !declared.has(c));
  if (missing.length > 0) {
    diags.push({ code: 'WRANGLER_MISSING_MIGRATION', severity: 'error', path: cfg.__path,
      message: 'Append this migration entry (migration history is an append-only record of what is ' +
               'already live — this build will never rewrite it):\n' +
               JSON.stringify({ tag: nextTag(cfg), new_sqlite_classes: missing }, null, 2) });
  }
}
```

### III.8 The runtime prose plane — in core, hash-guarded, cached

```ts
// packages/core/src/skills/fsAgentProse.ts
import type { FileSystem } from '../types/filesystem.js';
import { fsSkillStore } from './fsSkillStore.js';

export interface ProseGuard { readonly frontmatterHash: string; }

export function fsAgentProse(
  fs: FileSystem,
  id: string,
  guard: ProseGuard,
  opts: { root?: string; sharedSkillRoots?: readonly string[] } = {},
) {
  const root = opts.root ?? `/agents/${id}`;
  let cached: { hash: string; body: string } | undefined;

  return {
    instructions: async (): Promise<string> => {
      const content = await fs.readFile(`${root}/agent.md`);
      const { frontmatterHash, body } = splitAgentMd(String(content));

      // Fork 2's hazard, closed: config lives in the compiled artifact, so a frontmatter
      // edit here would otherwise be silently ignored. Fail loud instead (RFC §4.5).
      if (frontmatterHash !== guard.frontmatterHash) {
        throw new Error(
          `[prose] ${root}/agent.md frontmatter changed since the last build. ` +
          `Configuration is compiled, not runtime-loaded — run \`kuralle build\` and redeploy. ` +
          `Only the instruction body may change at runtime.`,
        );
      }
      cached = { hash: frontmatterHash, body };
      return body;
    },
    // fsSkillStore re-reads and re-parses every SKILL.md on EVERY call (fsSkillStore.ts:60-108).
    // Layer shared roots before the agent root: later roots win.
    skills: fsSkillStore(fs, [...(opts.sharedSkillRoots ?? []), `${root}/skills`]),
  };
}
```

> **Open cost, stated:** `fsSkillStore` has no cache. With `prose: runtime` on DO SQLite that is a
> full skill re-scan per `list()`/`loadBody()` call. Chunk 12 must either add a
> version-keyed cache (Eve's `cache-key.ts` model) or measure and accept the cost. It must not
> ship unmeasured.

> **Second cost, previously unstated:** with `prose: runtime`, a replayed trace no longer reproduces
> the run that produced it — the prompt is no longer in git *or* in the trace store. Given we
> shipped a trace store in 0.13.0, `prose: runtime` should record the body hash on the run span.

---

## Part IV — Revised work breakdown

Changes from RFC §8 are marked. Lanes follow `.agents/factory/lanes.md`.

| # | Chunk | Done when | Lane | Δ |
|---|---|---|---|---|
| 0 | **`agent.md` contract**: `yaml` dep, strict zod schema, `parseAgentMd` + `fnv1a` | V0 green | auto | **NEW — unblocks everything (§I.6)** |
| 1 | `@kuralle-agents/build` scaffold; `defineKuralleConfig` + resolution | V1 | auto | — |
| 2 | Singleton discovery (source-text heuristic) + `Lazy<T>` | V2, V6 | auto | scope narrowed (§III.3) |
| 3 | `assembleHarnessConfig` in core — **incl. `policy.ts`, `tools.ts`** | V3 | auto | **G2 gap (§I.4)** |
| 4 | `assembleAgentConfig` + `defineAgentPart` + `AgentAssemblyError` | V3 | auto | — |
| 5 | `discoverAgents` + diagnostics-as-data + path-flattened tool keys | V4 | auto | Eve's model (§II.4) |
| 6 | Identity helpers + `assertAgentIdentities` **incl. skills/subagents** | V5 | auto | **Fork 5** |
| 7 | ~~nested-YAML frontmatter~~ — **absorbed into chunk 0** | — | — | **removed** |
| 8 | Codegen `agents.ts` + `runtime.ts` (static imports, sorted) | V8 | auto | — |
| 9 | `kuralle build` + directory branch in `agentLoader` **+ multi-provider model resolution** | V7 | approve | **§I.1 trap** |
| 10 | CF target: worker codegen + DO classes **+ hard refusal when channels declared** | V9 | **full** | **§I.7 blocker** |
| 11 | wrangler validation: `nodejs_compat`, migration diff, printed JSON | V10 | **full** | — |
| 12 | `fsAgentProse` **in core**, hash guard, **skill-store caching decision** | V11 | approve | **§III.1, §III.8** |
| 13 | Examples (`minimal`, `full`, `cloudflare`) + guide + `cli.mdx` | V13, examples **executed** | auto | — |
| 14 | Live CF deploy verification | V12 recorded | approve | — |

Chunk 0 blocks 4, 5, 7-equivalents and 8. Chunks 3-6 parallelise once 0-2 land.

### Validation contract — additions

| # | Check | Gate |
|---|---|---|
| **V0** | `parseAgentMd`: `limits: { maxTurns: 12 }` yields the **number 12**; `outOfBandControl: true` yields a **boolean**; an unknown key **fails**; a changed frontmatter byte changes the hash | `bun test ./packages/build/test` |
| **V0b** | Regression: the RFC §4.3 example frontmatter round-trips to a correct `Partial<AgentConfig>` — the case the shipped flat parser gets wrong | `bun test` |
| V6 | `({env}) => …` store and tool resolve on both targets; **no module-scope `env` read appears in generated code** (assert on emitted text) | `bun test` + workerd |
| **V9b** | A project declaring a channel **fails** `build --target cloudflare` with `CF_CHANNELS_UNSUPPORTED` | `bun test` |
| **V11b** | `prose: runtime` + edited frontmatter → the turn throws the rebuild instruction; edited **body** → new prompt, no error | `bun test` + live CF probe |
| V8 | Generated config **structurally** equals a hand-written equivalent — compare scalars and key sets; assert tool/flow **identity** separately (deep-equal over closures is meaningless) | `bun test` |

> **CORRECTED.** RFC V8 says "deep-equals a hand-written equivalent". `AgentConfig` holds closures
> and class instances (§I.2); deep equality over those is either trivially false or silently
> shape-only. Split the assertion.

---

## Part V — Decisions needing a human call

1. **`policy.ts` / `tools.ts` as project singletons?** Recommended (§I.4). The alternative is
   narrowing G2's wording and documenting that four `HarnessConfig` fields require a code entry
   point. Either is defensible; silently shipping G2 as written is not.
2. **Is `voiceMode` dead?** Declared at `Runtime.ts:112` with no consumer found. If voice is gone,
   delete it rather than give it a file convention. Same question for `hostSelect`, already
   `@deprecated`.
3. **Chunk 10 sequencing.** Given §I.7, is RFC 0003 (channels) promoted ahead of the CF target, or
   does the CF target ship with an explicit "no channels" refusal and pharmacy stays hand-written
   until 0003? Recommended: the latter — the refusal is honest and unblocks 12 of 14 chunks.
4. **OKF v0.2.** Unchanged from RFC §13 Q4: ship against v0.1, file the upgrade as its own task.
5. **Subagent depth cap.** RFC proposes 3 (Mastra's). Eve has **no cap at all**. Recommended: keep 3;
   it is a diagnostic, not a limit anyone will hit honestly.

---

## Appendix — RFC claim verdicts

| RFC claim | Verdict |
|---|---|
| §2 CLI is `chat\|send\|sim\|trace` | **CORRECTED** — five commands; `resume` exists |
| §2 no build step exists | ✅ confirmed |
| §2 no project/config notion in the CLI | ✅ confirmed |
| §2 CF requires hand-written subclass + binding + migration | ✅ confirmed, and understated — three DO classes in the real app |
| §4.2 module-scope env breaks on workerd | ✅ confirmed — no framework-level env bridge exists |
| §4.4 a string satisfies `AgentConfig.model` | ✅ type-level; ⚠️ **not on the CLI path** (`resolveModel.ts:13-27`) |
| §4.5 fail-loud precedence | ✅ validated by Eve's shipped hard-fail model |
| §4.6 `fsSkillStore` reads any backend at runtime | ✅ confirmed — but **no cache**, and it swallows parse errors |
| §4.6 file citations under `packages/fs/src/` | **CORRECTED** — both files are in `packages/core/src/skills/` |
| §4.7 nothing validates DO identity today | ✅ confirmed |
| §5 `fsAgentProse` belongs in `@kuralle-agents/fs` | **CORRECTED** — belongs in core (§III.1) |
| §6.3 DO-SQLite FileSystem is real | ✅ **confirmed live-deployed** (`apps/playground/fs-demo-cf`) |
| §7 V8 deep-equality | **CORRECTED** — meaningless over closures |
| §8 chunk 7 "nested YAML" | **BLOCKER** — precondition, not a chunk (§I.6) |
| §10 no source change in `cf-agent` | ✅ plausible — but codegen inherits `@cloudflare/ai-chat`'s base-class contract |
| §12 channels deferred to RFC 0003 | **BLOCKER for chunk 10** — a hard dependency, not a deferral |
| §13 Q2 flat-YAML "open question" | **CORRECTED** — settled; the shipped parser mis-parses the RFC's own example |
| G2 every `HarnessConfig` field reachable | **CORRECTED** — four live fields have no home |
| G3 every `AgentConfig` field reachable | ✅ only where "file" means a `.ts` file — flows can never be data |
| G7 zero change to core types | ✅ holds |
