# RFC — Workspace completion: FS hardening + Shell capability + FS-backed Skills

**Status:** Draft → executing · **Date:** 2026-07-09 · **Owner:** octalpixel (manager-orchestrated, grok ICs)
**Relates to:** ADR-0006 (fs reframe), `docs/kuralle-core-teardown.md` (durability findings), `research/BLUEPRINT-whats-next.md` Phases 1–3.
**Grounded against (first-hand this session):** `withastro/flue` `packages/runtime/src/{sandbox,shell,agent,node/local-env,cloudflare/cf-sandbox,skill-frontmatter,skill-definition}.ts`; `just-bash@3.1.0` API; Mastra `@mastra/core@1.1.0`+ skills (agentskills.io spec); kuralle's existing `SkillsCapability` / `createFsTool` / `InMemoryFs`.

---

## 1. Problem & goal

Kuralle shipped `@kuralle-agents/fs` (Blueprint Phase 1): a portable `FileSystem` interface + `InMemoryFs` + `CompositeFileSystem` + a durable `workspace` tool, Node+CF-clean. Three gaps block it from being the harness substrate flue/Pi have:

1. **The `workspace` tool is unsafe under real use** — no output caps (a `cat` of a 1 MB file floods context *and* the durable session blob), `edit` replaces the first match with no uniqueness check (silent wrong-spot edits), grep honors only the `i` flag. (`docs/kuralle-core-teardown.md` §fs.)
2. **No shell.** The harness cannot run a command. flue and Pi both treat `FileSystem & Shell` as one capability; kuralle has the fs half only. A conversational agent rarely needs bash, but the *substrate* (skills with `scripts/`, a coding-style workspace, "run this validation") does.
3. **Skills are not baked into the workspace.** `SkillsCapability` exists (progressive disclosure via `load_skill` + `read_skill_resource`) but skills must be passed as inline objects or a bespoke store — they cannot live **on the workspace FileSystem** as `SKILL.md` folders (the agentskills.io / Claude / Mastra / flue model), and there is no `SKILL.md` frontmatter parser.

**End state (the "1"):** a Kuralle agent declares `workspace` (a `FileSystem`, optionally with a `Shell`) and `skills`; skills are discovered from the workspace as `SKILL.md` folders (agentskills.io spec), disclosed progressively, their bodies and `scripts/`/`references/` read through the same workspace, and — where a shell is attached — their scripts runnable. Everything Node + Cloudflare Workers portable, `just-bash` virtual by default (zero host access), exactly flue's three-backend shape. This is a **capability-injection** feature: absent `workspace`/`skills`, behavior is unchanged.

**Non-goals:** fixing the durable-journal scoping flaw (F4/F6/H1 — separate RFC; see §7 for the minimal mitigation this RFC *does* take); rebuilding RAG-as-fs (ADR-0006 killed KnowledgeFs-as-search); a remote (E2B/Daytona) sandbox adapter beyond the generic structural seam.

---

## 2. Design principles (from the research)

- **One capability seam, adapters behind it** (flue `SessionEnv`). kuralle already has `FileSystem`; add a peer `Shell` and a combined `Workspace` resolution. Do **not** merge fs+shell into one god-interface — keep them separable so a fs-only workspace needs no shell.
- **Cross-mode invariants live once, in core** (flue's `writeFileCreatingParents`, path normalization, abort pre/post checks). Output caps, edit-uniqueness, timeout composition live in the tool/core layer, not per backend.
- **Virtual-and-sandboxed by default** (flue default = `just-bash` + `InMemoryFs`, no host access). Host access (`local()`) and remote (`cloudflareSandbox()`) are explicit opt-ins.
- **Skill = pointer, not payload** (Pi/flue/Mastra all agree). Metadata (name+description) in the prompt; body + resources loaded on demand through the workspace read path. Never paste bodies inline.
- **agentskills.io spec compatibility** (Mastra + flue both conform). `SKILL.md` YAML frontmatter parsed with a failsafe schema (every scalar a string), `name` ≤64 `[a-z0-9-]`, `description` ≤1024, optional `license`/`compatibility`/`allowed-tools`/`metadata`. Unknown fields ignored, not rejected.
- **Tools return data only** (kuralle non-negotiable). Shell result = `{ stdout, stderr, exitCode }` structured; the model's `timeout` becomes a recoverable exit-124 result, not a throw (flue `agent.ts`).

---

## 3. Interfaces (the contracts ICs implement against)

### 3.1 `Shell` (new, in `@kuralle-agents/core` `src/types/shell.ts`)

```ts
export interface ShellResult { stdout: string; stderr: string; exitCode: number; }

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Primary deadline. Backends forward to their native timeout; signal-blind ones still honor it. */
  timeoutMs?: number;
  /** Best-effort mid-flight cancel. Backends without SDK support see it only pre/post call. */
  signal?: AbortSignal;
}

export interface Shell {
  exec(command: string, options?: ShellExecOptions): Promise<ShellResult>;
  cwd?: string;
}
```

### 3.2 Workspace config (extends `AgentConfig.workspace`, `src/types/agentConfig.ts` + `runtime/resolveAgentWorkspace.ts`)

```ts
export type AgentWorkspaceConfig =
  | FileSystem
  | { fs: FileSystem; shell?: Shell; readOnly?: boolean };

export interface ResolvedAgentWorkspace { fs: FileSystem; shell?: Shell; readOnly: boolean; }
```
`resolveAgentWorkspace` returns `shell` when present. **Back-compat:** a bare `FileSystem` still resolves to `{ fs, readOnly: true }`, `shell: undefined`.

### 3.3 `createShellTool` (new, `src/tools/fs/createShellTool.ts`, re-exported from `@kuralle-agents/fs`)

One durable-but-non-replayed (§7) tool named `bash`:
```ts
export interface CreateShellToolOptions { shell: Shell; timeoutMs?: number; }
// input: { command: string; timeout?: number /* seconds */ }
// returns: { op: 'bash'; ok: boolean; stdout: string; stderr: string; exitCode: number }
```
Rules: model `timeout` (seconds) → `timeoutMs`; on timeout return `exitCode: 124` recoverable result (never throw); host-signal abort rethrows. Output capped per §3.5. Registered into `executorTools` (never `globalTools`) — a shell is never auto-exposed. Only registered when `resolvedWorkspace.shell` is set.

### 3.4 `@kuralle-agents/fs` shell backends (new files in the fs package)

- `bashShell(bash: BashLike): Shell` — wraps a `just-bash` `Bash` instance. `BashLike` is a **structural** type (`exec`, `getCwd`, `fs`) so the fs package does not hard-import `just-bash` at type level.
- `virtualShell(opts?: { initialFiles?; fs?: FileSystem }): { fs, shell }` — convenience: constructs `just-bash` `Bash` over a `just-bash` `InMemoryFs`, returns both halves for `workspace: { ...virtualShell(), readOnly: false }`. **`just-bash` is a direct dep of `@kuralle-agents/fs`** (already flue's choice; Workers-clean, `network` off by default).
- `nodeShell(opts?: { cwd?; env? }): Shell` — Node `child_process.spawn`, ported from flue `node/local-env.ts`: probe real bash, own process group + SIGTERM→SIGKILL tree-kill, 64 MB output cap, **14-var env allowlist** (secrets never leak unless explicitly passed). Lives behind a subpath export `@kuralle-agents/fs/node` (has `node:*` imports).
- `cloudflareShell(stub: CloudflareSandboxStub, opts?: { cwd? }): Shell` — structural wrapper over a `@cloudflare/sandbox` DO stub (no hard dep), ported from flue `cloudflare/cf-sandbox.ts`. Subpath export `@kuralle-agents/fs/cloudflare`.

### 3.5 Output caps (new shared helper, `src/tools/fs/caps.ts` in core)

Applied by both `createFsTool` (read/cat/grep/find/ls) and `createShellTool`:
```ts
MAX_READ_LINES = 2000; MAX_READ_BYTES = 50 * 1024;
MAX_GREP_HITS = 200; MAX_GREP_LINE_LEN = 500;
MAX_LIST_ENTRIES = 1000; MAX_SHELL_OUTPUT_BYTES = 50 * 1024;
```
Truncation is explicit: results carry `{ truncated: true, ... }` and an appended note (`"… truncated at N lines; use offset/limit"`). Read gains `offset?`/`limit?` (1-indexed lines), matching flue/Pi.

### 3.6 FS-backed skill store (new, `@kuralle-agents/fs` `src/fs-skill-store.ts`)

```ts
export function fsSkillStore(fs: FileSystem, opts?: { root?: string }): SkillStoreLike;
// scans <root>/* for SKILL.md; parses frontmatter; list()→metas, loadBody()→markdown body,
// loadResource(name, path)→reads <root>/<name>/<path> via fs (path-escape guarded).
```
Plus a `parseSkillFrontmatter(content, ctx)` helper (agentskills.io: failsafe YAML, `name`/`description` required + limits, optional `license`/`compatibility`/`allowed-tools`/`metadata`; unknown fields ignored) — ported in spirit from flue `skill-frontmatter.ts`. `SkillStoreLike` already exists (`src/types/skills.ts`); `fsSkillStore` implements it, so it drops into `AgentConfig.skills` with **zero core wiring changes** (`wireAgentSkills` already accepts a store). Optional `defineSkill({ name, description, instructions, resources? })` inline helper mirroring flue/Mastra `createSkill`.

---

## 4. Work breakdown (chunks — each independently verifiable)

Ordered by dependency. C1/C4 are leaf (no cross-deps); C2→C3 serial; C5 depends on C4; C6 depends on all.

| # | Chunk | Package/paths | DoD (test-named) | Depends |
|---|---|---|---|---|
| **C1** | **FS tool hardening** | core `src/tools/fs/{createFsTool,caps}.ts` + fs `test/fs-tool.test.ts` | caps applied (read>2000 lines truncated w/ flag; grep>200 hits capped; line>500 truncated); `read`/`cat` accept `offset`/`limit`; `edit` throws on 0 or >1 matches, gains `replaceAll`; grep honors `g`/`m`/`s` + `i`. New tests green. | — |
| **C2** | **Shell interface + core wiring + `bash` tool + caps** | core `src/types/shell.ts`, `src/tools/fs/createShellTool.ts`, `runtime/resolveAgentWorkspace.ts`, `runtime/buildAgentToolSurface.ts`, `src/index.ts` | `AgentWorkspaceConfig` accepts `{ fs, shell }`; `resolveAgentWorkspace` returns `shell`; `buildAgentToolSurface` registers `bash` into `executorTools` **iff** `shell` set, never in `globalTools`; timeout→124 recoverable; non-replayed per §7. Unit tests (fake `Shell`) green. | — |
| **C3** | **fs shell backends** | fs `src/{bash-shell,virtual-shell}.ts`, `src/node/node-shell.ts`, `src/cloudflare/cf-shell.ts`, subpath exports in `package.json`; `just-bash` dep added | `bashShell` + `virtualShell` run a real `just-bash` exec (`echo hi` → stdout `hi\n`, exit 0) — bun test; `nodeShell` runs on host (guarded), env allowlist enforced; `cf-shell` structural wrapper compiles + workers-vitest smoke. | C2 |
| **C4** | **FS-backed skill store + frontmatter** | fs `src/{fs-skill-store,skill-frontmatter,define-skill}.ts` + exports | `parseSkillFrontmatter` accepts spec-valid SKILL.md, rejects missing name/description + >64/>1024, ignores unknown fields; `fsSkillStore(fs)` over an `InMemoryFs` with two `SKILL.md` folders → `list()` 2 metas, `loadBody` returns body, `loadResource` reads `references/x.md`, path-escape blocked. bun tests green. | — |
| **C5** | **Skills-on-workspace integration** | core `runtime/buildAgentToolSurface.ts` (accept `fsSkillStore` unchanged), verify `wireAgentSkills` + `SkillsCapability` disclose fs skills | An agent with `workspace: fs` and `skills: fsSkillStore(fs)` exposes `load_skill`/`read_skill_resource`, prompt lists metas, `load_skill` returns body from fs. Integration test green (no live model). | C4 |
| **C6** | **Examples (live) + docs** | fs `examples/{workspace-skills-shell,skills-on-fs}.ts`, `README.md`, ADR-0006 addendum or new ADR-0012 | Two runnable examples: (a) agent + `virtualShell()` workspace + `fsSkillStore` skills → **live smoke run** (real model, real just-bash exec, skill load observed); (b) read-only skills-on-fs. READMEs updated same change. Untested example = broken example. | C2,C3,C4,C5 |

**Surface-collision fences:** C1 and C2 both edit `createFsTool.ts` neighborhood — C1 owns `createFsTool.ts`+`caps.ts`, C2 owns `createShellTool.ts` and only *appends* to `buildAgentToolSurface.ts` (fs-tool block untouched). C2 and C5 both touch `buildAgentToolSurface.ts` — C2 adds the shell block, C5 changes nothing there (skills already wired), so no real overlap; sequence C2 before C5 to be safe.

---

## 5. Validation contract

- `cd packages/fs && bun test test/*.test.ts && vitest run --config vitest.config.ts` (adds shell + skill-store + caps tests; workers pool for CF).
- `cd packages/core && bun test` (shell tool + workspace resolution + audit harness F1–F9 still green — no regression).
- `bun run build` (topological; **rebuild `@kuralle-agents/core` before fs** — stale-dist gotcha) then `bun run typecheck`.
- **Live smoke (C6):** run `examples/workspace-skills-shell.ts` against a real model; observe (1) skill metadata in prompt, (2) `load_skill` tool call returning a body read from the fs, (3) a `bash` call executing in `just-bash` and returning real stdout. "Untested example = broken example" — do not mark C6 done on typecheck alone.

---

## 6. Portability contract (Node + Cloudflare, the standing rule)

- Core (`Shell` type, `createShellTool`, `caps`, `createFsTool`): **zero `node:*`**. Workers-clean.
- `@kuralle-agents/fs` root export (`bashShell`, `virtualShell`, `fsSkillStore`, `skill-frontmatter`): zero `node:*` — `just-bash` + `InMemoryFs` run on workerd. Frontmatter YAML parser must be a Workers-safe dep (no `node:*`); if `js-yaml` pulls `node:*`, use a minimal pure-JS frontmatter parse (the spec only needs flat scalar/`list` frontmatter).
- `@kuralle-agents/fs/node` (`nodeShell`): `node:child_process`/`node:fs` — Node only, isolated subpath.
- `@kuralle-agents/fs/cloudflare` (`cloudflareShell`): structural DO-stub wrapper, no hard `@cloudflare/sandbox` dep.
- CF workers vitest must cover: `virtualShell` exec + `fsSkillStore` over `InMemoryFs`.

---

## 7. The durability decision (load-bearing — read before implementing C2)

The teardown proved kuralle's durable journal is broken cross-turn: `runId === sessionId`, callsite ordinals reset per turn, so a stable-arg tool call **replays a stale cached result** (F6) or, with a shifted ordinal, **re-executes** (F4); and effects are recorded *after* execution (H1). Routing `bash` and fs *reads* through that journal is actively wrong: a `cat` returns last week's file (F6), and a re-executed `bash rm` / `write` double-applies.

**Decision for this RFC:** shell and fs tools are **non-replayed** — they always execute, never return a journal-cached result. Implement via a `replay?: false` flag on `defineTool` (default `true` = today's behavior) honored in `runtime/ctx.ts` `tool()` (when `def.replay === false`, skip `findStepByKey`, always call `execute`, still append a record for audit). Apply `replay: false` to `createFsTool` and `createShellTool`. This matches flue/Pi (best-effort, at-least-once) and *removes* the F6 stale-read hazard for exactly these tools without waiting on the journal-scoping fix. It does **not** give exactly-once — a crash mid-`bash` can re-run it (H1); that is documented, and true exactly-once is the separate journal-scoping RFC. **This is the one core-semantics change; it is surgical (one flag, one branch) and must be surfaced in ADR.**

---

## 8. Risks

- **`just-bash` on workerd** — validate the CF vitest exec smoke early (C3); if a `just-bash` transitive pulls `node:*`, pin the import to its Workers entry or gate `virtualShell` behind the node subpath (fallback, worse DX).
- **YAML dep portability** — see §6; prefer a tiny pure parser over `js-yaml` if the latter isn't workerd-clean.
- **Scope creep into the journal fix** — explicitly out of scope; the `replay:false` flag is the only journal touch. Do not "fix F6 properly" here.
- **`edit` uniqueness is a behavior change** — existing callers relying on first-match replace will now throw on ambiguity; acceptable (safer, matches flue/Pi), note in ADR.

---

## 9. Delegation plan (manager)

grok ICs, `/delegate` per chunk with the brief carrying the relevant §3 interface verbatim. Parallel wave 1: **C1 + C4** (leaf, no overlap). Then **C2** → **C3** + **C5** (parallel) → **C6** (manager-run live smoke, not delegated — needs model keys + observation). Manager reviews every diff against the DoD, fixes ≤5-line gaps, re-briefs structural failures.
