# Pi Coding-Agent Primitives → Kuralle General Agentic Harness — Plan

## 1. Thesis

Pi is two packages with one load-bearing boundary: a **headless agent core** (`research/pi/packages/agent`) — a hand-coded tool-call loop + sessions + compaction + system-prompt assembly, observable only via events — and a **coding application** (`research/pi/packages/coding-agent`) that injects the four fs/bash tools, skills, extensions, and a TUI on top. Kuralle already has the loop's structural superset (flows/routing/handoffs in `openRun.ts`, durable `defineTool`, a `SessionStore` interface, hooks), but it is **missing the four primitives that turn a flow engine into a general agentic *workspace* harness**: (a) an injected fs/exec capability seam, (b) usage-driven compaction, (c) a lazy file-backed Skills primitive, and (d) a session message identity (`id`/`parent`) that enables forking. The right move is **not** to clone Pi's coding agent — it is to lift its *interfaces* (the `ExecutionEnv` Result-typed seam, the usage-based compaction logic, the lazy-skill stub) into kuralle-core as **capability-gated, runtime-pluggable** additions, so they work on Node but degrade cleanly to "no fs / no shell" on Cloudflare Workers where `cf-agent` runs.

### TL;DR — proposed changes (minimal, grounded)

- **New package `@kuralle-agents/workspace`** — holds the `ExecutionEnv` (`FileSystem & Shell`, Result-typed, never-throws) interface + a Node impl + an in-memory impl, and a factory `createWorkspaceTools(env, { mode })` that returns Kuralle `defineTool` instances (`read`/`write`/`edit`/`bash`/`grep`/`find`). Copies Pi's `harness/types.ts:268-332` interface verbatim; copies Pi's `coding-agent/src/core/tools/*Operations` injection pattern.
- **One new `AgentConfig` field: `workspace?: WorkspaceCapability`** (`packages/kuralle-core/src/types/agentConfig.ts:16-51`) — `{ env, mode: 'read-write'|'read-only'|'off', skills? }`. Derived (the existing house pattern), not a new tagged agent kind. The workspace tools are merged into `globalTools` so they are model-visible per-turn exactly like today's base-layer allow-list (`agentConfig.ts:28-33`).
- **New `skills?: Skill[]` under `workspace`** — Pi's lazy `{name, description, content, filePath}` stub model: emit an `<available_skills>` block (name/description/**location**) into instructions, and let the model `read` the file via the workspace `read` tool. Copies `harness/skills.ts` + `system-prompt.ts:3-25`. Three lines of context per skill, zero cost until invoked.
- **New compaction subsystem in core: `packages/kuralle-core/src/runtime/compaction/`** — usage-driven (`shouldCompact` from real provider `Usage`, not char/4), cut at a turn boundary, summarize via an LLM call with a fixed checkpoint prompt, store the summary and replay-kept-history. Copies `harness/compaction/compaction.ts` logic (`:165-706`); wired at one call site near `openRun.ts:104` (before-prompt) plus turn-end. Fully portable — pure logic + one model call.
- **Two optional `RunState` fields: `messageMeta?: Record<idx, {id, parentId}>`** (or move to per-message ids) to enable Pi's append-only `id`+`parent` tree → forking. `RunState.messages` is a flat `ModelMessage[]` today (`runtime/durable/types.ts:34`); add identity *beside* it, do not restructure. Defer the `/tree` navigation UI.

What we are **NOT** doing: no TUI, no `jiti` extension loader, no second message-storage format (Kuralle keeps `SessionStore`), no typebox (Kuralle stays zod), no replacing flows with a bare loop.

---

## 2. Pi primitive map (file-cited)

### 2.1 Agent layer — `research/pi/packages/agent/src` (portable, headless)

| # | Primitive | Where | Essence |
|---|---|---|---|
| P1 | Tool-call/exec turn loop | `agent-loop.ts:155-269` | drain follow-ups → stream assistant → exec tool batch → push results → `turn_end`; between-turn hooks `prepareNextTurn`/`shouldStopAfterTurn` (`:226-251`); batch stops only if **all** results `terminate:true` (`:544-546`) |
| P2 | Tool registry = array + policy seam | `agent-loop.ts:373-708`, `types.ts:360-384` | `AgentTool` (typebox), `executionMode` seq/parallel, `before/afterToolCall` block/rewrite hooks (`types.ts:262-276`); errors encoded as tool results, never thrown (`:710-715`) |
| P3 | Provider boundary | `agent-loop.ts:275-368` | `transformContext` then `convertToLlm` — the only place `AgentMessage[]`→LLM `Message[]`; `StreamFn` **must not throw** (`types.ts:24-26`) |
| P4 | Open `AgentMessage` union | `types.ts:300-309`, `messages.ts:54-61` | declaration-merged custom roles (bashExecution/summary) coexist with model history via `convertToLlm` |
| P6 | **`ExecutionEnv = FileSystem & Shell`** | `harness/types.ts:268-332` | every method returns `Result<T, FileError>`, **never throws** (`:266`); `Shell.exec(...)→Result<{stdout,stderr,exitCode}>`; only Node impl is `env/nodejs.ts` |
| P7 | Session = append-only entry **tree** | `harness/types.ts:334-454`, `session/session.ts:82-266` | `SessionTreeEntry` w/ `{id,parentId,timestamp}`; `buildContext()` walks root→leaf, replays to `AgentMessage[]`, honors compaction boundary (`:61-72`) |
| P8 | Two storage backends | `session/{memory,jsonl}-storage.ts` | in-memory (portable) + JSONL-one-line-per-entry (needs 4-method `FileSystem` slice) |
| P9 | **Usage-based compaction** | `harness/compaction/compaction.ts` | `estimateContextTokens` uses real `Usage` (`:165-193`); `shouldCompact = tokens > window - reserve` (`:196-199`); `findCutPoint` snaps to turn boundary (`:329-377`); LLM summary w/ fixed prompt (`:379-453,627-706`) |
| P11 | **Lazy Skills + prompt templates** | `harness/skills.ts`, `system-prompt.ts:3-25` | `Skill={name,description,content,filePath}` (`types.ts:46-57`); emit `<available_skills>` (name/desc/**location**); model reads file via tool — not inlined |
| P12 | `AgentHarness` orchestrator | `harness/agent-harness.ts:174-1065` | wires env/session/tools/compaction; `message_end`→append, `turn_end`→flush (`:511-528`); typed hook map |

### 2.2 Coding-agent layer — `research/pi/packages/coding-agent/src/core` (the application)

| # | Primitive | Where | Essence |
|---|---|---|---|
| A | `AgentSession` composition | `agent-session.ts:256` | the reusable app object; subscribes events + persists (`_handleAgentEvent:476`), drives loop via `_runAgentPrompt:936` (retry+compact+queue-drain) |
| B | `ToolDefinition` + `Operations` injection | `extensions/types.ts:433-491`, `tools/bash.ts:40`, `tools/read.ts:43` | each tool takes an `Operations` iface (`BashOperations.exec`, `ReadOperations.readFile`) so fs/exec can be remoted; default impls are `node:child_process`/`node:fs` |
| C | Tool registry/factories | `tools/index.ts:83,168-177` | `read|bash|edit|write|grep|find|ls`; default active `["read","bash","edit","write"]` (`sdk.ts:244`); allow/deny filter (`agent-session.ts:2282`) |
| D | Event bus + stream | `event-bus.ts:3`, `agent-session.ts:124,476` | `node:events` wrapper for extensions; `AgentSessionEvent` = harness events + app events |
| E | Extensions `(pi)=>void` | `extensions/types.ts:1093,1388`, `loader.ts:340-523` | capability object: `registerTool/on(event)/exec/...`; loaded via `fs.readdirSync` + `jiti` — **Node-only, least portable** |
| F | `SessionManager`/`ModelRegistry`/compaction | `session-manager.ts:757`, `model-registry.ts:405`, `compaction/` | JSONL tree + branching; `inMemory()` portable; resolver logic pure |

### 2.3 The transcript's design principles (`research/_sources/transcripts/gTeujlv8qK0.txt`)

Core/UI separation; loop coded from scratch (no Agents-SDK/AI-SDK loop); JSONL `id`+`parent` tree for free forking; **trust the model's own `usage` numbers — never char/4**; `checkCompaction()` runs at exactly two points (agent-end + before-prompt); **lazy skill load via tool-read, not inlining** (~3 lines context/skill); capability gating (`--tools`) tied to RPC safety; everything pluggable via events + extensions.

---

## 3. Reusable vs coding-specific vs runtime-specific

**Reusable for a conversational harness (lift the interface):** P1 loop shape, P2 policy seam, P3/P4 message-conversion two-step, **P6 `ExecutionEnv`**, P7/P8 session-tree idea, **P9 compaction (entirely conversation-agnostic)**, P11 lazy skills, the `Operations`-injection pattern (B), the `(pi)=>void` capability shape (E, conceptually).

**Coding-specific (do not lift as core):** the 7 tools' behavior, `file-mutation-queue`, edit-diff/truncate, `OutputAccumulator`, file-op tracking in summaries (`compaction/utils.ts`), branch summarization (P10).

**Runtime-specific (won't run on Cloudflare Workers):** `env/nodejs.ts` (`spawn`/`node:fs`), `createLocalBashOperations`/`execCommand` (`node:child_process`), `extensions/loader.ts` (`jiti`/`createRequire`/`readdirSync`), `output-guard.ts` (stdout takeover), JSONL-on-fs layout. **All of these sit behind interfaces** (`ExecutionEnv`, `Operations`, `SessionStorage`) whose in-memory variants are portable — that is exactly why the seam matters.

---

## 4. Deconstruction to primitives — minimal interfaces

The four irreducible interfaces Kuralle is missing, each copied from a named Pi source:

```ts
// (1) IO/exec seam — copy of pi harness/types.ts:268-332, Result-typed, never-throws.
interface FileSystem {
  readTextFile(p: string): Promise<Result<string, FileError>>;
  writeFile(p: string, data: string): Promise<Result<void, FileError>>;
  appendFile(p: string, data: string): Promise<Result<void, FileError>>;
  listDir(p: string): Promise<Result<DirEntry[], FileError>>;
  exists(p: string): Promise<Result<boolean, FileError>>;
  readonly cwd: string;
}
interface Shell {
  exec(command: string, opts?: ExecOpts): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecError>>;
}
type ExecutionEnv = FileSystem & Shell;

// (2) Lazy skill — copy of pi harness/types.ts:46-57.
interface Skill { name: string; description: string; filePath: string; content?: string; }

// (3) Compaction config + check — copy of pi compaction.ts:115,196-199.
interface CompactionSettings { enabled: boolean; reserveTokens: number; keepRecentTokens: number; }
// shouldCompact(usageTokens, contextWindow, settings): boolean

// (4) Message identity for forking — Pi's id+parent (transcript) on RunState.messages.
interface MessageMeta { id: string; parentId?: string; }
```

### Comparison across studied systems

| Dimension | Pi agent core | Pi coding-agent | Kuralle today | Kuralle proposed |
|---|---|---|---|---|
| Tool primitive | `AgentTool` (typebox, `onUpdate`) | `ToolDefinition` + `Operations` | `defineTool` (zod, `execute`, durable effect-log) `tools/effect/defineTool.ts:13` | keep `defineTool`; add workspace tools via `Operations`-style env injection |
| fs/exec | `ExecutionEnv` (`harness/types.ts:332`) | `BashOperations`/`ReadOperations` | **none** on `AgentConfig` (`agentConfig.ts:16-51`) | `workspace.env: ExecutionEnv` |
| Skills | lazy stub (`skills.ts`) | `/skill:` interception | **none** | `workspace.skills: Skill[]`, lazy |
| Compaction | usage-based (`compaction.ts:165`) | overflow-recovery (`agent-session.ts:1793`) | **none** (`RunState.messages` grows unbounded `durable/types.ts:34`) | `runtime/compaction/` usage-based |
| Session | JSONL `id`+`parent` tree | `SessionManager` tree | flat `RunState.messages` + `SessionStore` iface (`SessionStore.ts:9`) | add `MessageMeta` beside messages |
| Control flow | bare tool loop | bare loop + retry | **flows/routing/handoffs** (`openRun.ts`, `agentConfig.ts:34-38`) | keep flows; workspace is orthogonal |
| Extensibility | `(pi)=>void` + events | `jiti` loader | `Hooks` (`onToolCall`/`onTurnEnd`/`onStreamPart`, `hooks/HookRunner.ts`) | reuse existing hooks; no new loader |
| Portability seam | interface + Node impl | `Operations` per tool | `SessionStore` swappable | one `ExecutionEnv` injection point |

The sharpest contrast: **Pi has no flows; Kuralle has no workspace.** They are complementary axes. Kuralle should add the workspace axis without disturbing flows — a `defineAgent` with `flows` and one with `workspace` are both valid, and an agent may have both (a flow node whose `action` shells out via the workspace env).

---

## 5. Proposed Kuralle design (concrete, minimal)

### 5.1 New package `@kuralle-agents/workspace`

```
packages/kuralle-workspace/src/
  types.ts          # ExecutionEnv = FileSystem & Shell  (verbatim copy of pi harness/types.ts:268-332)
  result.ts         # Result<T,E> + FileError/ExecError codes (pi harness/types.ts:111-119)
  env/node.ts       # NodeExecutionEnv — spawn + node:fs/promises  (copy of pi env/nodejs.ts)
  env/memory.ts     # InMemoryExecutionEnv — Map-backed fs, no shell (portable; for tests + Workers KV/R2 later)
  tools.ts          # createWorkspaceTools(env, { mode }): Record<string, AnyTool>  via Kuralle defineTool
  skills.ts         # loadSkills(env, dir): Skill[]; formatSkillsBlock(skills): string  (copy of pi skills.ts + system-prompt.ts:3-25)
  index.ts
```

`createWorkspaceTools` returns **Kuralle** `defineTool` instances (zod input, durable `execute`) — it does NOT introduce a parallel tool type. Each tool closes over the injected `env` (Pi's `Operations`-injection pattern, `coding-agent/tools/bash.ts:40`):

```ts
// packages/kuralle-workspace/src/tools.ts
export function createWorkspaceTools(env: ExecutionEnv, opts: { mode: WorkspaceMode }) {
  const read = defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file from the workspace.',
    input: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      const r = await env.readTextFile(path);          // never throws — Result
      return r.ok ? { content: r.value } : { error: r.error.code };
    },
  });
  const tools: Record<string, AnyTool> = { read, grep: makeGrep(env), find: makeFind(env) };
  if (opts.mode === 'read-write') {
    Object.assign(tools, { write: makeWrite(env), edit: makeEdit(env), bash: makeBash(env) });
  }
  return tools;
}
```

This satisfies CLAUDE.md "tools return data only" (`Tool`-result is data; flow control stays in node transitions) and reuses the durable effect-log exactly-once guarantee that `defineTool` already provides (`tools/effect/defineTool.ts`).

### 5.2 The one `AgentConfig` field

Add **one derived field** to `packages/kuralle-core/src/types/agentConfig.ts` (after `memory`, mirroring how `flows`/`routes` derive behavior):

```ts
export interface AgentConfig {
  // ...existing...
  knowledge?: AgentKnowledge;
  memory?: AgentMemory;
  /** Workspace capability (ADR-pending). When set, fs/exec tools are made
   *  model-visible per speaking turn (merged into the base-layer allow-list),
   *  gated by `mode`. `env` is injected by the host: Node provides a real fs+shell;
   *  Cloudflare Workers must pass an in-memory/KV-backed env or omit `workspace`. */
  workspace?: WorkspaceCapability;
}
export interface WorkspaceCapability {
  env: ExecutionEnv;                // from @kuralle-agents/workspace
  mode: 'read-write' | 'read-only';
  skills?: Skill[];                 // lazy; emitted as <available_skills>, read on demand
}
```

**Wiring (surgical, two touch points):**
1. **Tool exposure** — where `globalTools` is resolved into `RunContext.globalTools` (`run-context.ts:89`, set when entering a turn), merge `createWorkspaceTools(workspace.env, { mode: workspace.mode })`. This reuses the *existing* base-layer mechanism (`agentConfig.ts:28-33`) — workspace tools become model-visible in speaking turns exactly like FAQ-lookup is today. No new execution path.
2. **Skills in instructions** — where instructions are composed (the `baseInstructions` prefix, `run-context.ts:84-88`), append `formatSkillsBlock(workspace.skills)` + the one-line "if a skill is invoked, read its file" instruction (Pi's `system-prompt.ts` rule). Lazy: the block is name/description/location only.

### 5.3 Compaction in core (portable)

New `packages/kuralle-core/src/runtime/compaction/compaction.ts`, copying Pi's logic (`harness/compaction/compaction.ts:165-706`):
- `estimateContextTokens(messages, lastUsage)` — prefer real provider `Usage`; fall back to char/4 only for the trailing tail (transcript: "trust the LLM's own usage numbers").
- `shouldCompact(tokens, contextWindow, settings)` (`:196-199`).
- `findCutPoint` snaps to a user/assistant turn boundary, never mid-tool-result (`:261-377`).
- `compact()` — one `generateText` call (Kuralle already depends on `ai`) with a fixed Goal/Progress/Decisions/Next-Steps prompt; the summary is stored and the kept history replayed.

Wired at **one** site: in `openRun.ts` after the run state is loaded and before the model turn (analogue of Pi's "before the prompt", `:104-105`), plus a turn-end check via the existing `onTurnEnd` hook (`hooks/HookRunner.ts:83`). The summary lives in `RunState` (e.g. `compactionSummary?: string; firstKeptIndex?: number`); message-array assembly skips pre-cut messages and prepends the summary — the same replay Pi does in `buildSessionContext:61-72`. **Configurable via a new `compaction?: CompactionSettings` on `AgentConfig` or `HarnessConfig` (`Runtime.ts:41`); default `{ enabled: false }`** to keep current behavior byte-identical until opted in.

### 5.4 Node vs Cloudflare portability strategy

| Layer | Node (`hono-server`) | Cloudflare Workers (`cf-agent`) |
|---|---|---|
| `ExecutionEnv` | `NodeExecutionEnv` (real fs + `spawn`) | **no shell**; `InMemoryExecutionEnv` or a KV/R2-backed `FileSystem` with `Shell.exec` returning `Result.err('unsupported')` |
| `createWorkspaceTools` | full set incl. `bash` | `mode: 'read-only'` (no `bash`/`write`); or omit `workspace` entirely |
| Skills | load from disk via env | bundle skill `content` inline (already-loaded `Skill[]`), still lazy-referenced |
| Compaction | portable (pure + 1 model call) | portable — identical |
| Session identity | portable | portable (Kuralle's `SessionStore` already abstracts both) |

The contract that makes this safe is Pi's: **every `ExecutionEnv` method returns a `Result` and never throws** (`harness/types.ts:266`). A Workers env that lacks a shell returns a typed error; the model sees a tool result, not a crash — matching Kuralle's existing "errors encoded as tool results" posture and CLAUDE.md's portability requirement. **Capability-gating is mandatory** (transcript principle 6): `workspace` is opt-in, and the default active toolset honors `mode` so an RPC/automation caller can run read-only.

### 5.5 What to copy vs invent

- **Copy the design, don't invent:** `ExecutionEnv` interface (`harness/types.ts`), the lazy-skill stub (`skills.ts` + `system-prompt.ts`), and the usage-based compaction (`compaction.ts`) are proven, file-cited, and portable. Copy them.
- **Do NOT** adopt: typebox (stay zod), the `jiti` extension loader (Kuralle's `Hooks` already cover `registerTool`-equivalent extension points), JSONL-on-fs (Kuralle has `SessionStore`), the TUI, branch-summarization, `file-mutation-queue` (add only if concurrent edits become a real problem).

---

## 6. Use-case walkthrough — support agent with a local knowledge base

A customer-support agent whose KB is a folder of markdown files plus a few Skills (refund policy, escalation script). Developer-facing API:

```ts
import { defineAgent } from '@kuralle-agents/core';
import { NodeExecutionEnv, loadSkills } from '@kuralle-agents/workspace';

const env = new NodeExecutionEnv({ cwd: './support-kb' });

export const supportAgent = defineAgent({
  id: 'support',
  model: openai('gpt-4.1'),
  instructions: 'You are Acme support. Ground every policy answer in the knowledge base files; never invent policy.',
  workspace: {
    env,
    mode: 'read-only',                       // safe for an automated support channel — no write/bash
    skills: await loadSkills(env, './skills'), // SKILL.md frontmatter → {name, description, filePath}
  },
  // flows still apply — e.g. a refund collect/decide flow can coexist:
  flows: [refundFlow],
  routing: { mode: 'structured' },
});
```

What the model sees per turn:
- The base instructions + an `<available_skills>` block listing e.g. `refund-policy — when/how refunds are issued — ./skills/refund-policy/SKILL.md` (name/desc/location only — ~3 lines each, lazy).
- Model-visible tools `read`, `grep`, `find` (no `write`/`bash`, because `mode: 'read-only'`).

Conversation: user asks "what's your refund window?" → model `grep`s the KB / `read`s `refund-policy/SKILL.md` on demand (driven by the "if a skill is invoked, read its file" instruction) → answers grounded in file content. The KB stays out of the prompt until needed — context cost is flat regardless of KB size (transcript principle 7). For long sessions, `compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 8000 }` checkpoints old turns into a structured summary so a multi-hour support chat never overflows.

**Same agent on Cloudflare** (`cf-agent`): swap `NodeExecutionEnv` for an `InMemoryExecutionEnv` seeded with the KB files at deploy time (or a KV-backed `FileSystem`), keep `mode: 'read-only'`, pass `skills` with `content` pre-loaded. The agent definition is otherwise identical — the only runtime-specific line is which `ExecutionEnv` is constructed.

---

## 7. Open questions

1. **Compaction config home — `AgentConfig` or `HarnessConfig`?** Pi puts it on the session/harness, not per-agent. Kuralle has per-agent context windows differ; recommend `AgentConfig.compaction` with a `HarnessConfig` default. Confirm.
2. **Message identity placement.** Add `MessageMeta` as a parallel `RunState.messageMeta?: Record<number,{id,parentId}>`, or restructure `RunState.messages` to `{message, id, parentId}[]`? The latter is cleaner (Pi's shape) but touches every `runState.messages` reader (`openRun.ts:55,67,96-100`, channels, drivers). Recommend the parallel map first; restructure only if forking ships.
3. **Does workspace belong in `globalTools` or a new resolution path?** Merging into the base-layer allow-list reuses existing wiring but means workspace tools are *not* exposed during non-speaking collect-extraction (`agentConfig.ts:30-32`) — correct for read tools, but a flow `action` node that needs `bash` would need explicit `effectTools` access. Confirm the boundary.
4. **Skill invocation — implicit (model reads) vs explicit (`/skill:` command)?** Pi's coding-agent has both; the *core* primitive is only the lazy stub. Kuralle has no slash-command layer (no TUI). Ship implicit-only; defer explicit invocation.
5. **Workers `FileSystem` backend.** In-memory works for bundled KBs; a KV/R2-backed `FileSystem` is a larger effort. Scope v1 to in-memory + Node only?

## 8. Risks / non-goals

- **Risk: `bash`/`write` are a foot-gun on a conversational agent.** Mitigated by mandatory `mode` gating (default `read-only` if unsure) and by never auto-enabling workspace — it is opt-in per agent (transcript principle 6, capability gating for RPC safety).
- **Risk: stale-dist (CLAUDE.md).** `@kuralle-agents/workspace` and core compaction must be built + published together — core's `AgentConfig.workspace` type references the workspace package's `ExecutionEnv`. Either invert the dependency (define `ExecutionEnv` *in core*, impls in the package) or publish in one release. **Recommend defining the `ExecutionEnv`/`Skill`/`CompactionSettings` interfaces in `kuralle-core/src/types/` and the Node/in-memory impls + tool factories in `@kuralle-agents/workspace`** — keeps the type graph one-directional.
- **Non-goal: TUI / interactive mode.** Kuralle is a conversational server/Workers framework; Pi's `pi-interactive` has no analogue and none is wanted.
- **Non-goal: `jiti` extension loader.** Kuralle's `Hooks` (`hooks/HookRunner.ts`) already cover tool-call interception and turn lifecycle; a dynamic-import plugin loader is Node-only and unsafe on Workers.
- **Non-goal: replacing flows with a bare loop.** Flows/routing/handoffs are Kuralle's differentiator; workspace is an orthogonal capability, not a competing control model.
- **Non-goal: a second session-storage format.** Keep `SessionStore`; do not port JSONL-on-fs. Add message identity inside the existing store.
