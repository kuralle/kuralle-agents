# ADR 0012 — Workspace completion: Shell capability, FS-backed Skills, and non-replayed effect tools

**Status:** Accepted · **Date:** 2026-07-09 · **Extends:** ADR-0006 (fs reframe)

## Context

ADR-0006 narrowed `@kuralle-agents/fs` to two jobs: the substrate Skills/Scripts mount on, and bundled local files + a writable scratch. It shipped `FileSystem` + `InMemoryFs` + `CompositeFileSystem` + the read-only-by-default `workspace` tool. Three gaps remained before that substrate matched what flue (`SessionEnv = FileSystem & Shell`, skills as `SKILL.md` folders) and Pi/Mastra actually provide:

1. The `workspace` tool had no output caps, no `edit` uniqueness check, and honored only the `i` grep flag — unsafe once results flow into both model context and the durable session blob.
2. No **Shell**. The harness could read/write files but not run a command — so skill `scripts/` and any "run this" step were impossible.
3. Skills could not live **on** the workspace filesystem as `SKILL.md` folders (the agentskills.io spec that Anthropic/Claude, Mastra, and flue all conform to); they had to be inline objects or a bespoke store.

We also re-read the durability teardown (`docs/kuralle-core-teardown.md`): the durable effect journal is broken cross-turn (`runId === sessionId`, per-turn callsite ordinals), so a stable-arg tool call **replays a stale cached result** (F6) or **re-executes** (F4). Routing filesystem *reads* and shell *execs* through that journal is actively wrong — a `cat` would return last week's file; a re-executed `bash`/`write` would double-apply.

## Decision

### A. Harden the `workspace` fs tool (`createFsTool` + `caps.ts`)
Output caps applied in one shared core helper (`MAX_READ_LINES=2000`, `MAX_READ_BYTES=50KB`, `MAX_GREP_HITS=200`, `MAX_GREP_LINE_LEN=500`, `MAX_LIST_ENTRIES=1000`); results carry an explicit `truncated` flag + note. `read`/`cat` gain `offset`/`limit`. `grep` honors `g/i/m/s`. `edit` throws on 0 or >1 matches (matching flue/Pi) and gains `replaceAll` — silent wrong-spot edits are now impossible.

### B. Add a `Shell` capability (mirrors flue's three-backend model)
- Core owns the interface (`Shell.exec(command, { cwd, env, timeoutMs, signal }) → { stdout, stderr, exitCode }`, `src/types/shell.ts`) and the durable `bash` tool (`createShellTool`): the model's `timeout` (seconds) becomes a recoverable **exit-124** result, never a throw; host-abort (via the executor's injected `ctx.abortSignal`) rethrows; output is capped. Tools return data only.
- `AgentConfig.workspace` extends to `{ fs, shell?, readOnly? }`; `bash` auto-registers into the **executor** surface (never `globalTools` — a shell is never auto-exposed to the model; the developer opts in per node, same posture as a writable fs tool under ADR-0006).
- `@kuralle-agents/fs` ships the backends behind **subpath exports** (never the root — see below): `virtualShell()` (a `just-bash` `Bash` over an in-memory fs, network off — `@kuralle-agents/fs/shell`), `nodeShell()` (`child_process`, env-allowlisted, process-group tree-kill — `@kuralle-agents/fs/node`), and `cloudflareShell()` (structural `@cloudflare/sandbox` DO-stub wrapper — `@kuralle-agents/fs/cloudflare`).
- **Portability correction (learned in build):** `just-bash`'s bundle pulls `turndown`, which is **not workerd-clean**, so `virtualShell` cannot ship on the root export without poisoning the whole package's Workers build. The root `@kuralle-agents/fs` (fs primitives + skills) stays Workers-clean; the just-bash virtual shell is an opt-in `/shell` subpath for **Node and CF containers**. The shell for the Cloudflare *edge* is `cloudflareShell` (wrapping a Sandbox Durable Object), not `virtualShell`. The earlier "just-bash virtual = CF-Workers-clean default" framing was wrong and is retracted.

### C. Skills live on the workspace filesystem (agentskills.io spec)
`fsSkillStore(fs, { root })` scans `<root>/*` for `SKILL.md` folders, parses YAML frontmatter with a Workers-clean pure-JS parser (`name` ≤64 `[a-z0-9-]`, `description` ≤1024, optional `license`/`compatibility`/`allowed-tools`/`metadata`, unknown fields ignored), and implements the existing `SkillStoreLike` — so it drops into `AgentConfig.skills` with **zero wiring change**. Progressive disclosure is unchanged (metadata in prompt via `SkillsCapability`; body + `references/` loaded on demand through `load_skill`/`read_skill_resource`). `defineSkill({ name, description, instructions, resources })` mirrors flue `defineSkill` / Mastra `createSkill` for inline skills.

### D. Non-replayed effect tools (`defineTool({ replay: false })`)
`Tool` gains `replay?: boolean` (default `true` = today's exactly-once journal behavior). When `false`, `ctx.tool` **always executes** and never returns a journal-cached result (it still appends an audit record with a uniquified key). `createFsTool` and `createShellTool` set `replay: false`. This makes fs/shell tools **at-least-once** (flue/Pi semantics) and removes the teardown's F6 stale-read hazard for exactly these tools — a `cat` is always fresh, not replayed from an earlier turn.

## Consequences
- The workspace is now a real `FileSystem & Shell` substrate, Node + CF portable, virtual-and-sandboxed by default.
- Skills are portable `SKILL.md` folders on that filesystem — the same artifacts Claude/Mastra/flue consume.
- fs/shell tools are honest about their semantics: **at-least-once, always-fresh**, not the (broken) exactly-once the default journal advertises. Documented, tested (`test/audit-validation/10-replay-false.test.ts`).
- `replay: false` is the **only** change to durable-journal semantics; the default (replay-true) path is untouched, and the F1–F9 audit harness stays green.

## Non-goals / rejected
- **Fixing the journal-scoping flaw (F4/F6/H1) properly** — separate RFC. `replay: false` is the surgical mitigation for fs/shell, not the general fix; a crash mid-`bash` can still re-run it (at-least-once).
- **Auto-exposing `bash` in `globalTools`** — rejected; a shell is opt-in per node, never automatic.
- **A remote (E2B/Daytona) sandbox adapter** beyond the generic structural `Shell` seam — deferred; the interface is ready for it.
