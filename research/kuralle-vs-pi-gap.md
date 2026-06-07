# Kuralle vs Pi — Primitive Gap Analysis

## Thesis

Kuralle-core is a **structured-conversation harness** (flows, routes, handoffs, durable effect-tools, gated streaming) — Pi is a **flat agentic coding harness** (one tool-loop over a filesystem + shell, lazy skills, append-only session tree, usage-driven compaction). The two overlap on the loop, tool execution, sessions, and streaming, where Kuralle is *at parity or ahead* (durability/exactly-once, capabilities, multi-transport). The real distance to a "Pi-class agentic harness" is **four concrete primitives Kuralle has zero source for**: (1) a `FileSystem`+`Shell` capability injection seam, (2) skills as first-class on-disk resources loaded lazily via a read-tool, (3) an append-only session *tree* (vs the current flat `RunState.messages`) with automatic usage-driven compaction, and (4) an env/system-context injector into the prompt. None of these require touching Kuralle's flow/route identity — they slot in as a new optional capability layer. The cleanest path is to **copy Pi's proven `ExecutionEnv` interface and skills-by-pointer design verbatim**, expose them through a new `workspace?` field on `AgentConfig`, and ship the fs/shell tools as ordinary `defineTool()` durable effect tools.

### TL;DR — proposed changes

- **New package `@kuralle-agents/workspace`** holding the portable `ExecutionEnv = FileSystem & Shell` interface (copied from Pi `harness/types.ts:268,321,332`), a `NodeExecutionEnv` (Node fs/child_process), and a `CfExecutionEnv` (R2/KV/D1-backed fs, no shell). Result-typed, never-throw.
- **New `AgentConfig.workspace?: WorkspaceConfig`** field (`{ env, skillsDir?, readOnly? }`) — the single seam. Absent ⇒ today's behavior unchanged.
- **Built-in fs/shell tools via `defineTool()`** (`read`, `write`, `edit`, `ls`, `glob`, `grep`, `bash`) bound to the injected `env`; a `readOnly` profile that drops `write/edit/bash` (Pi's tool-allowlist read-only profile, transcript Primitive #4).
- **Skills primitive**: `loadSkills(env, skillsDir)` → `<available_skills>` prompt block + lazy load via the `read` tool (Pi Primitive #8). No content pasted into context.
- **Session tree + usage-driven compaction** (Phase 3, larger): add `parentId` to run/session entries and a `compact()` triggered on measured provider `usage` at turn boundaries (Pi `compaction.ts`, transcript Primitive #6). This is the one item that touches `openRun`/`RunState`.
- **`AgentConfig.env?`** injector: a small typed map merged into the system prompt (date, cwd, workspace root) — Pi's `<env>` section (transcript Primitive #7).

---

## Centerpiece — primitive gap table

Pi paths relative to `research/pi/packages/agent/src/`; Kuralle paths relative to `packages/kuralle-core/src/`. Effort: S ≤ 1d, M ≈ 2–4d, L ≈ 1–2wk (one engineer).

| Primitive | Pi mechanism + file | Kuralle status + file | Gap | Effort |
|---|---|---|---|---|
| **Agent loop (reason→act→observe)** | `agentLoop`/`runLoop` — outer follow-up drain + inner `while(hasMoreToolCalls)` (`agent-loop.ts:31,155`) | `Runtime.run`+`hostLoop` host loop (`runtime/Runtime.ts:88`, `runtime/hostLoop.ts:33`) + inner `TextDriver.runAgentTurn` `streamText` loop bounded by `maxSteps`=5 (`runtime/channels/TextDriver.ts:66,32`) | **None for the inner loop.** Kuralle's is flow/route-dispatched, not "model decides all" — but the inner tool-loop exists and is bounded. Pi has no flows; Kuralle has both. | — (parity) |
| **Tool execution engine** | parallel/sequential by batch, `prepareArguments`, `before/afterToolCall`, `terminate`, streaming `onUpdate`, error-as-result (`agent-loop.ts:373-708`) | `CoreToolExecutor`: zod validate, serial-default/opt-in parallel, timeout race, abort/barge-in, interim filler, enforcer policy (`tools/effect/ToolExecutor.ts:35-253`) | **Near parity.** Missing only: per-tool `executionMode:'sequential'` self-selection and result-level `terminate` flag. Streaming partials already covered by `interim` (`ToolExecutor.ts:146`). | S |
| **Durable / exactly-once tools** | *(none — Pi tools are best-effort)* | `ctx.tool()` → `replayOrExecute` against append-only effect log keyed by `sha256(runId,callsite,name,args)` (`runtime/ctx.ts:190-220`, `durable/idempotency.ts:17-32`) | **Kuralle ahead.** Pi has nothing here. | — (ahead) |
| **Tool schema** | TypeBox `TSchema`/`Static` (`types.ts:361`) | Zod `defineTool({input})` (`tools/effect/defineTool.ts:13-47`) | Different libs; Kuralle's is fine. Only matters if literally porting Pi tool code. | — |
| **Filesystem capability** | `FileSystem` iface, Result-typed never-throw, backend-independent error codes (`harness/types.ts:268`); `NodeExecutionEnv` (`harness/env/nodejs.ts:217`) | **ABSENT.** Only fs users: `memory/blocks/FilePersistentMemoryStore.ts` (markdown KV, NODE-ONLY) + observability JSON exporter. No file tools, no `fs`/`workspace` on AgentConfig (`types/agentConfig.ts:16-51`) | **Hard gap.** No read/write/edit/ls/glob/grep. The central missing primitive. | M |
| **Shell / bash exec** | `Shell.exec(command,{cwd,env,timeout,abortSignal,onStdout})` (`harness/types.ts:321`); spawn + process-tree kill (`harness/env/nodejs.ts:147,192`) | **ABSENT.** No `child_process`/`spawn` anywhere in core (grep: none) | **Hard gap.** Harness cannot run commands. Node-only by nature; CF supplies a no-op/remote shell. | M |
| **Capability scoping / read-only** | tool-set allowlist; "read-only" = `read,grep,find` profile, no bash (transcript Primitive #4, `gTeujlv8qK0.txt:1`) | Tool surfaces exist (`effectTools`/`globalTools`, `agentConfig.ts:27-33`) but **no read-only profile** for fs/shell tools | Add a `readOnly` flag that selects the safe subset. Trivial once fs/shell tools exist. | S |
| **Skills (on-disk, lazy)** | `SKILL.md` load + `<available_skills>` XML block (`harness/system-prompt.ts:3`, `harness/skills.ts:38`); model pulls body via `read` tool (transcript Primitive #8) | **ABSENT** (grep "skill": none) | **Hard gap.** No skill type, registry, loader, or prompt injection. Depends on fs primitive existing first. | M |
| **Slash-command / prompt templates** | `loadPromptTemplates` (`.md`+YAML frontmatter), `substituteArgs` `$1/$@/$ARGUMENTS` (`harness/prompt-templates.ts:30,249`) | **ABSENT** | Soft gap; lower priority than skills. Same fs dependency. | M |
| **Env / system-context injection** | `<env>` section (date, cwd) + `agents.md` files appended; layered prompt base+append+override (transcript Primitive #7) | **ABSENT.** No `env` field; `process.env` only in HTTP-tool expander + memory-dir resolution | Soft gap. Add `AgentConfig.env?` map merged into instructions. | S |
| **Session storage** | `SessionStorage` iface: append-only, `appendEntry/getPathToRoot` (`harness/types.ts:440`); `InMemory` (CF-safe) + `Jsonl` backends | `SessionStore` get/save/delete/list (`session/SessionStore.ts:9-18`); `MemoryStore` only in core (`session/stores/MemoryStore.ts`); Redis/PG in sibling pkgs | Interface parity, but Kuralle saves whole-session blobs vs Pi's append-per-entry. Not a blocker. | — |
| **Session shape (tree vs list)** | **append-only DAG**: `SessionTreeEntry` (13 types incl `model_change`, `leaf`), `parent`-pointer, `getPathToRoot`, fork/branch (`harness/types.ts:334-420`, `session/session.ts:82`) | **flat list**: `RunState.messages: ModelMessage[]` (`runtime/durable/types.ts:25-37`); config changes mutated in place, no parent pointer, no forking | **Real architectural gap.** Forking / branch-navigation / config-journaling impossible without `parentId`. | L |
| **Compaction** | usage-driven (`usage.input+output+cache`), fires at turn-end & pre-prompt, structured checkpoint summary (`compaction.ts:165,196,329,627`; transcript Primitive #6) | overflow-*recovery* (`runtime/contextOverflow.ts:94,157`) + per-flow `reset_with_summary` (`flow/contextStrategy.ts:32-79`); **no automatic rolling compaction**, budget accounting only (`runtime/ContextBudget.ts`) | Gap: Kuralle compacts reactively on overflow error or flow strategy; Pi compacts proactively on measured size. | M |
| **Streaming** | event lifecycle `message_start/update/end`, `tool_execution_*` (`agent-loop.ts`) | native AI-SDK `HarnessStreamPart` `text-start/delta/end/cancel` + tool/flow/handoff events, `TurnHandle` (`types/stream.ts:9-44`) | **Kuralle ahead** (AI-SDK-native, gated streaming, SSE/NDJSON). | — (ahead) |
| **Hooks / extensibility** | typed event bus `subscribe()`/`on(type)` with result-patch map (`agent-harness.ts:1050`, `types.ts:704`); TS extension interface (transcript Primitive #9) | `Hooks` (`types/hooks.ts:7-17`) + `HarnessHooks` (observability), Input/OutputProcessors (`types/processors.ts:32-54`), capabilities (`agentConfig.ts:43-46`) | Comparable. Kuralle has no **plugin/extension registry** (register-tool/command/shortcut/CLI-flag) — but that's a frontend concern, lower priority. | S (if wanted) |
| **Run modes / transports** | one `AgentSession` factory → TUI / RPC / stdio (transcript Primitive #10) | `createRuntime` → hono-server (Node/Bun) + cf-agent (Workers/DO). No TUI/stdio. | Parity on the surfaces that matter for a framework. | — |

**Summary read:** Kuralle is *ahead* on durability, capabilities, and AI-SDK-native streaming; *at parity* on the loop, tool engine, and session interface; and has **four hard gaps** — fs, shell, skills, session-tree+proactive-compaction — that together constitute "not yet a Pi-class agentic harness."

---

## Phased roadmap

**Phase 1 — Workspace capability (the fs/shell core).** New `@kuralle-agents/workspace` package: `ExecutionEnv` interface + `NodeExecutionEnv`. `AgentConfig.workspace?` field. Built-in `read/write/edit/ls/glob/grep/bash` tools via `defineTool()`, bound to the env. `readOnly` profile. — *Effort M; unblocks everything else. Highest value.*

**Phase 2 — Skills + env injection.** `loadSkills(env, skillsDir)` → `<available_skills>` system-prompt block; lazy load via the `read` tool. `AgentConfig.env?` map → `<env>` prompt section. Prompt templates (slash-commands) optional, defer. — *Effort M; depends on Phase 1's `read` tool.*

**Phase 3 — Session tree + proactive compaction.** Add `parentId` to run entries; `getPathToRoot`-style replay; `compact()` fired on measured provider `usage` at turn boundaries with Pi's structured-checkpoint prompt; branch/fork navigation. — *Effort L; touches `openRun`/`RunState`. Do last — it's the deepest change and least blocking for "agentic coding" use cases.*

**Phase 4 (optional) — CF parity + plugin registry.** `CfExecutionEnv` (R2/KV/D1 fs, no-op or remote shell); a `definePlugin`/extension registry if a Studio/TUI frontend lands. — *Effort M; only if CF workspace agents or a plugin ecosystem are required.*

---

## Deconstruction to primitives

The minimal irreducible interfaces, stripped of feature framing:

1. **Capability injection** — `ExecutionEnv = FileSystem & Shell`, every method `Result<T,E>`, contractually never-throw, backend-independent error codes. *This is the single portability seam.* (Pi `harness/types.ts:266,268,321`)
2. **Tool-set as capability scope** — capability = which tools are in the set; "read-only" is a profile, not branching logic. (Pi transcript Primitive #4)
3. **Skill = pointer, not payload** — give the model name+description+location; it `read`s the body on demand. (Pi transcript Primitive #8)
4. **Session = append-only log + parent pointer** — a flat append log with `parentId` *is* a tree; forking is free. (Pi `harness/types.ts:440`, transcript Primitive #5)
5. **Compaction = measured-size-triggered structured summary** at turn boundaries. (Pi `compaction.ts:196,627`)
6. **Layered prompt** — tiny base + ordered typed sections (env / skills / tools / history). (Pi transcript Primitives #2,#7)

### Cross-system comparison

| Primitive | Pi (agent core) | Kuralle today | Direction |
|---|---|---|---|
| Capability injection seam | `ExecutionEnv` (fs+shell), Result-typed | none (only `FilePersistentMemoryStore` fs) | **copy Pi's interface** |
| Tool durability | best-effort | exactly-once effect log (`ctx.tool`) | keep Kuralle's; layer fs tools on top |
| Tool schema | TypeBox | Zod (`defineTool`) | keep Zod |
| Skills | on-disk, lazy-by-read | none | **copy Pi's lazy design** |
| Session shape | append-only tree (parent ptr) | flat `RunState.messages` | **adopt parent pointer (Phase 3)** |
| Compaction trigger | measured `usage`, proactive | overflow-error reactive + flow strategy | **add proactive usage trigger** |
| Streaming | custom event union | AI-SDK-native `HarnessStreamPart` | keep Kuralle's (ahead) |
| Prompt model | base+append+override, `<env>`/`<skills>` | `Instructions` string/fn (`agentConfig.ts:11`) | extend with env+skills sections |

---

## Proposed Kuralle design (minimal, grounded)

### New package: `@kuralle-agents/workspace`

```
packages/kuralle-workspace/src/
  types.ts          // ExecutionEnv = FileSystem & Shell (COPIED from Pi harness/types.ts:268,321)
  env/node.ts       // NodeExecutionEnv  (node:fs/promises + node:child_process) — NODE-ONLY
  env/cloudflare.ts // CfExecutionEnv    (R2/KV/D1 fs; shell = no-op or remote)  — Phase 4
  tools.ts          // defineTool() bindings: read/write/edit/ls/glob/grep/bash
  skills.ts         // loadSkills(env, dir) + formatSkillsForSystemPrompt  (COPIED from Pi skills.ts:38)
  readonly.ts       // readOnly tool-set profile (read/ls/glob/grep only)
```

Why a new package and not core: the **interface** is portable, but `NodeExecutionEnv` imports `node:child_process`/`node:fs` — exactly the boundary the deploy-primitives plan keeps out of core. Core stays runtime-neutral; `@kuralle-agents/workspace` is the impl. (Mirrors how Redis/Postgres stores live in sibling packages, `Runtime.ts:81` ships only `MemoryStore`.)

### Exact `AgentConfig` additions

Add to `packages/kuralle-core/src/types/agentConfig.ts` (after `globalTools`, line 33):

```ts
  /** Filesystem + shell capability for fs/skills/bash tools. Absent ⇒ no workspace tools.
   *  env is supplied by @kuralle-agents/workspace (NodeExecutionEnv | CfExecutionEnv). */
  workspace?: {
    env: ExecutionEnv;          // FileSystem & Shell, Result-typed, never-throw
    skillsDir?: string;         // load SKILL.md files → <available_skills> + lazy read
    readOnly?: boolean;         // drop write/edit/bash; expose read/ls/glob/grep only
  };
  /** Typed context merged into the system prompt as an <env> section (date, cwd, root). */
  env?: Record<string, string>;
```

`ExecutionEnv` is imported as a *type only* (`import type`) from `@kuralle-agents/workspace` — no runtime dep in core, no `node:*` leak. Core's prompt assembler reads `config.env` and the loaded skills; everything else lives in the workspace package.

### Built-in tools via `defineTool()`

Workspace tools are ordinary Kuralle durable effect tools — they get exactly-once replay for free (`ctx.tool`, `runtime/ctx.ts:190`):

```ts
// @kuralle-agents/workspace/tools.ts
import { z } from 'zod';
import { defineTool } from '@kuralle-agents/core';

export function workspaceTools(env: ExecutionEnv) {
  const read = defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file from the workspace.',
    input: z.object({ path: z.string(), offset: z.number().optional(), limit: z.number().optional() }),
    execute: async ({ path, offset, limit }) => {
      const r = await env.fs.readTextLines(path, offset, limit);   // Result<...>, never throws
      return r.ok ? { content: r.value } : { error: r.error.code }; // data only — Kuralle rule
    },
  });
  const bash = defineTool({
    name: 'bash',
    description: 'Run a shell command in the workspace.',
    input: z.object({ command: z.string(), timeoutMs: z.number().optional() }),
    needsApproval: true,                                            // consequential ⇒ gate
    execute: async ({ command, timeoutMs }, ctx) => {
      const r = await env.shell.exec(command, { timeout: timeoutMs, abortSignal: ctx.signal });
      return r.ok ? { stdout: r.value.stdout, exitCode: r.value.exitCode } : { error: r.error.code };
    },
  });
  // write/edit/ls/glob/grep follow the same shape.
  return { read, ls, glob, grep, ...(/* not readOnly */ { write, edit, bash }) };
}
```

Tools **return data only** (Kuralle's non-negotiable rule, `CLAUDE.md`), errors become values (Pi's never-throw contract, `harness/types.ts:266`). `bash`/`write`/`edit` carry `needsApproval` so the existing durable-approval pause (`ctx.approve`, `ctx.ts:133`) governs consequential ops.

### Skills (lazy, copied from Pi)

`loadSkills(env, skillsDir)` scans `SKILL.md` files, emits an `<available_skills>` block (name + description + location only) into the system prompt via the existing `Instructions` callback (`agentConfig.ts:11-14`). The standing instruction tells the model: *"to use a skill, `read` its location."* The model pulls the body through the `read` tool — no content baked into context (Pi `system-prompt.ts:3`, transcript Primitive #8). This requires the `read` tool to exist (Phase 1) — hence the ordering.

### Node vs Cloudflare portability

- **Portable (both):** the `ExecutionEnv` *interface*, `workspaceTools(env)`, `loadSkills`, the `readOnly` profile, all `defineTool` bindings — they touch `env` only through the interface. The session-tree + compaction logic (Phase 3) is pure-JS.
- **Node-only:** `NodeExecutionEnv` (`node:child_process` + `node:fs`), exactly mirroring Pi's single Node boundary (`harness/env/nodejs.ts:217`).
- **Cloudflare:** supply `CfExecutionEnv` — `FileSystem` over R2/KV/D1, `Shell.exec` either a no-op returning `ExecutionErrorCode` or a call to a remote runner. Nothing above changes because everything depends on the interface, not the impl. (Same strategy the deploy-primitives plan uses for two first-party targets.)

---

## Use-case walkthrough — customer-support agent with a local KB + a skill

A support agent whose knowledge base is a folder of markdown docs on disk, plus a "refund-policy" skill, plus read-only file search. Developer-facing API:

```ts
import { defineAgent, createRuntime } from '@kuralle-agents/core';
import { NodeExecutionEnv } from '@kuralle-agents/workspace';

const env = new NodeExecutionEnv({ cwd: './support-kb' });

const supportAgent = defineAgent({
  id: 'support',
  model: openai('gpt-4.1-mini'),
  instructions:
    'You are a customer-support agent. Answer ONLY from the knowledge base. ' +
    'To consult a policy skill, read its file location.',
  // NEW: workspace capability — read-only KB + skills
  workspace: {
    env,
    skillsDir: './support-kb/skills',  // contains refund-policy/SKILL.md
    readOnly: true,                    // exposes read/ls/glob/grep — no write/edit/bash
  },
  env: { workspace_root: './support-kb' },  // → <env> section in the prompt
  // existing fields still work unchanged:
  globalTools: { /* e.g. order_lookup */ },
});

const runtime = createRuntime({ agents: [supportAgent], defaultAgentId: 'support' });
const turn = runtime.run({ input: 'How do I get a refund for order 123?', sessionId });
for await (const part of turn.events) { /* AI-SDK-native stream, unchanged */ }
```

What happens: the prompt gets an `<env>` section + an `<available_skills>` block listing `refund-policy` (description + location only). The model `grep`s the KB, finds the order, then `read`s `skills/refund-policy/SKILL.md` to ground the refund answer — body pulled lazily, context stays lean. Because `readOnly: true`, `write/edit/bash` are never in the tool set, so the support agent structurally cannot mutate the KB or run commands. The KB lookups are durable effect tools, so a mid-turn retry replays the same `read` results (`ctx.tool`, `ctx.ts:190`).

For a **scripts** use case (e.g. a data-analyst agent), drop `readOnly`, and `bash` becomes available with `needsApproval` — every command pauses for human approval via the existing durable-approval flow before running.

---

## Open questions

1. **Session tree (Phase 3) — adopt or skip?** Forking/branch-navigation is Pi's distinctive primitive, but Kuralle's value is *structured flows*, not exploratory branching. Is a forkable transcript actually wanted, or is proactive compaction on the existing flat list enough? (The flat→tree change touches `openRun.ts:105`/`RunState`.)
2. **Compaction trigger placement.** Pi fires at turn-end + pre-prompt on measured `usage`. Kuralle has `ContextBudget`/`TokenAccumulator` (`runtime/ContextBudget.ts`) — do those already expose provider `usage` to drive a proactive trigger, or only post-hoc accounting? Needs a read before committing.
3. **CF shell semantics.** Is a no-op `Shell` (returns `ExecutionErrorCode.unsupported`) acceptable on Workers, or do CF workspace agents need a remote-runner shell? Affects whether Phase 4 is S or M.
4. **Skill spec.** Adopt the agentskills.io `<available_skills>` markup Pi uses verbatim, or define a Kuralle-native one? Verbatim = interop with Pi/Claude-Code skills already on disk.
5. **Tool naming collision.** Pi's `read/write/edit/bash` are generic names — do they conflict with any existing `globalTools`/`effectTools` conventions or model expectations in Kuralle examples?

## Risks / non-goals

- **Non-goal: rebuild Pi.** Kuralle keeps flows/routes/handoffs as its identity; the workspace layer is *additive and optional* (absent `workspace` ⇒ zero behavior change). We are not making Kuralle a flat tool-loop.
- **Non-goal: a TUI.** Pi's custom terminal UI is runtime-specific and out of scope; Kuralle's transports are hono-server + cf-agent.
- **Risk: shell on a server is a security surface.** `bash` in a multi-tenant Node deployment is dangerous; it must default OFF (no `workspace` ⇒ no shell) and `needsApproval` must be the default for `bash/write/edit`. The `readOnly` profile should be the documented default for any internet-facing support agent.
- **Risk: Phase 3 scope creep.** Session-tree + compaction is the deepest change and least blocking — sequencing it last protects the high-value Phase 1/2 from being held hostage to a `RunState` refactor.
- **Risk: TypeBox→Zod friction if porting Pi tool code.** Pi tools use TypeBox (`types.ts:361`); we are *re-implementing* the tools in Zod `defineTool`, not porting — copying the *design*, not the code. This is intentional (CLAUDE.md: copy the proven design).
