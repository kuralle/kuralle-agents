# Understanding: file-based agents (kuralle ← Eve / Mastra / Flue / OKF)

**Date:** 2026-07-25 · **Scope:** what a file-based agent is in the current market, what kuralle
already has that maps onto it, and what genuinely does not exist yet.
**Companion:** [`rfcs/0001-file-based-agents.md`](../rfcs/0001-file-based-agents.md)

---

## 1. Top-down — what the four references actually do

| | **Eve** (Vercel) | **Mastra** | **Flue** (withastro) | **OKF** (Google) |
|---|---|---|---|---|
| Unit of an agent | directory | directory | ES module | n/a (knowledge, not agents) |
| Marker | `instructions.md` present | `config.ts` **or** `instructions.md` present | `'use agent'` directive in the prologue | `type:` frontmatter key |
| Identity | file/dir path | directory name | exported **function name**, or `Fn.agentName = '<literal>'` | file path minus `.md` |
| Config authoring | `agent.ts` | `config.ts` → `agentConfig({...})` partial | TS hooks (`useModel`, `useTool`, `useSkill`) | YAML frontmatter |
| Tools | `tools/*.ts`, filename = tool name | `tools/*.ts`, filename = key | `useTool(fn)` explicit | — |
| Skills | `skills/*.md` | `skills/<n>/SKILL.md` + `references/` | `import s from './SKILL.md'` | — |
| Binding time | build | **build** (fs discovery → codegen) | **build** (AST scan → virtual module) | read time |
| Deploy target | Vercel (Workflows/Sandboxes) | its own `deployer` | Node **and Cloudflare** via Vite plugin | — |

Two families, and the split is the whole design question:

- **Directory-convention** (Eve, Mastra): the *filesystem shape* is the config. An agent can exist
  with no TypeScript at all.
- **Module-directive** (Flue): the *function* is the agent; the directive only tells the build
  "this module has special semantics". Flue needs this because a Flue agent is a function body
  that runs hooks — there is no data object to discover.

**Both bind at build time.** Neither loads agents by walking a filesystem at runtime. That is not
an aesthetic choice: `workerd` has no filesystem and cannot `import()` an arbitrary path, so any
framework that claims Cloudflare support must resolve every code reference before deploy.

### The Cloudflare mechanism, concretely (Flue)

`packages/vite/src/agent-scan.ts` and `cloudflare-worker-config.ts` are the reference implementation:

1. Glob the source root, parse each candidate with `parseAstAsync` (oxc), keep files whose
   **directive prologue** contains `use agent` — real ECMAScript semantics, not regex
   (`agent-scan.ts:357-372`).
2. Every exported capitalized function is an agent. Identity = export name, or a statically
   readable `Fn.agentName = '<literal>'` (`agent-scan.ts:511-661`).
3. Identity → `Flue<Pascal>Agent` class + `FLUE_<SNAKE_UPPER>_AGENT` binding
   (`agent-scan.ts:311-318`).
4. Three separate collision gates before codegen: duplicate identity, **distinct identities that
   fold to the same generated identifier** (`IssueTriage` vs `issue-triage`), and one function
   exported under two agent names (`agent-scan.ts:693-745`).
5. A Vite plugin serves a virtual worker entry; a `flueWorkerConfig()` customizer merges `main`,
   the per-agent DO bindings, and `nodejs_compat` into the *resolved* wrangler config —
   **it never writes the user's `wrangler.jsonc`** (`cloudflare-worker-config.ts:31-46`).

The load-bearing lesson is in `cloudflare-target.md:50-63`:

> Migration history stays user-authored — Flue never writes it, because it is an ordered,
> append-only record of your deployments.

Because identity → DO class name → **storage identity**, renaming an agent function is a data
migration. Flue makes the user own that, and validates rather than repairs.

### Mastra's discovery, concretely

`packages/deployer/src/build/fs-routing/discover.ts` performs **no module evaluation** — pure
`lstat`/`readdir`/`readFile`, producing path descriptors for codegen. Notable hardening worth
copying wholesale: every `lstat` is symlink-*detecting*, and symlinks are skipped, because "a
symlinked module file could point anywhere on the build machine and be embedded into generated
import code." Test files are skipped. Order is sorted, so codegen is deterministic.

Assembly is a separate, filesystem-free pure function — `assembleAgentFromFsEntry`
(`packages/core/src/agent/fs-routing/index.ts:160`) — which makes the precedence rules
unit-testable. Their rules: dynamic (function) `config.instructions` beats `instructions.md`;
otherwise `instructions.md` beats a static `config.instructions`; on tool-key collision config
wins with a warning.

Mastra also carries `workspaceSeedDir` with the comment "(Eve parity)" — they are explicitly
tracking Eve.

### OKF

Orthogonal to agent definition: it is a format for the *knowledge* an agent reads — a directory of
markdown with YAML frontmatter, `type` the only required key. **The spec in the repo is v0.2**
(provenance, trust tiers, lifecycle, attested computation); kuralle implements v0.1
(`packages/fs/src/okf.ts:1`). Relevant here only because it confirms the shape file-based agents
should use for a `knowledge/` directory, and because it is a shipped, versioned gap.

---

## 2. Bottom-up — the seams already in kuralle

This is the part that makes the RFC small. Six of the seven pieces exist.

| Need | Already in kuralle | Evidence |
|---|---|---|
| An agent as **data**, not a class | `defineAgent(config) { return config }` — a plain `AgentConfig` object | `packages/core/src/types/agentConfig.ts:68-70` |
| Load an agent **by shape** | `classifyExport` resolves Runtime \| AgentConfig \| factory | `packages/cli/src/agentLoader.ts:61-79` |
| Portable filesystem | `FileSystem` + InMemory / Node / SQL(DO-SQLite) / R2 backends | `packages/fs/src/{in-memory-fs,node,sql,cloudflare}` |
| Markdown+frontmatter parsing | two independent parsers already shipped | `packages/fs/src/skill-frontmatter.ts:14`, `packages/fs/src/okf.ts:36` |
| `SKILL.md` folders as a skill source | `fsSkillStore(fs)` reads `/skills/<n>/SKILL.md` at **runtime**, over any backend | `packages/fs/src/fs-skill-store.ts:6-56` |
| A CF Durable-Object agent host | `KuralleAgent` — abstract `getAgents(): HarnessConfig['agents']` | `packages/cf-agent/src/KuralleAgent.ts:67-80` |
| **A build step** | ✗ **does not exist** | `packages/cli/src/cli.ts` has only `chat \| send \| sim \| trace` |

Two findings that materially shape the design:

**(a) A string is already a valid model.** In the installed `ai@6.0.193`:

```ts
type LanguageModel = GlobalProviderModelId | LanguageModelV3 | LanguageModelV2;
```

resolved via `globalThis.AI_SDK_DEFAULT_PROVIDER ?? gateway` (`dist/index.mjs:878`). So
`model: 'openai/gpt-4.1-mini'` typechecks as an `AgentConfig.model` **today**. A complete
`AgentConfig` is therefore expressible in YAML frontmatter with zero TypeScript — the "just write
`instructions.md`" promise Eve makes needs no new model-resolver layer in kuralle.

**(b) The current loader cannot reach Cloudflare.** `resolveBuildRuntime` does
`await import(pathToFileURL(abs).href)` (`agentLoader.ts:178`) — Node-only, runtime, dynamic.
That is the exact call `workerd` cannot make. File-based discovery must therefore produce a
*generated module with static imports*, not a runtime directory walk, for anything code-shaped.

**(c) ADR-0012 already names these frameworks as the bar.** Its context section justifies the
Shell/FS-skills work against "what flue (`SessionEnv = FileSystem & Shell`, skills as `SKILL.md`
folders) and Pi/Mastra actually provide". File-based agents are the next item on that same list,
not a new direction.

---

## 3. The consequence: kuralle has a capability the references don't

Flue, Mastra and Eve all collapse to one plane — everything is resolved at build. Kuralle has a
**portable `FileSystem` that works inside a Durable Object** (`SqlFs` over DO SQLite, ADR-0013)
and a skill store that already reads from it at runtime.

So kuralle can split the problem where the references cannot:

- **Code plane** (tools, flows, subagent wiring, model objects) — must be compiled at build time.
  No alternative on `workerd`.
- **Prose plane** (instructions, skills, knowledge) — *may* be compiled in, but can equally be
  read from a `FileSystem` at runtime. On CF that filesystem is DO SQLite, so an agent's prompt,
  skills, and knowledge bundle can change **without a redeploy**.

That is not a feature to bolt on later; it decides the file format now, because the format has to
be readable by both the build-time compiler and the runtime loader.

---

## 4. What is genuinely missing

1. A convention: which directory, which filenames, what maps to which `AgentConfig` field.
2. A discovery pass — filesystem-only, no module evaluation (Mastra's shape).
3. An assembly function — pure, no I/O, unit-testable (Mastra's `assembleAgentFromFsEntry`).
4. A codegen + `kuralle build`, because the CLI has no build command.
5. A Cloudflare target: identity → DO class + binding, wrangler contribution, migration discipline
   (Flue's shape, and Flue's restraint about not owning migration history).
6. Identity/collision validation — cheap to write, and the thing that corrupts durable storage if
   skipped.

Nothing here requires changing `AgentConfig`, the runtime, or `KuralleAgent`. The build produces
exactly the value those already accept.
