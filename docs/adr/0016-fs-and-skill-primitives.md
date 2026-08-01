# ADR 0016 — FS and Skill primitives: freeze the filesystem, invest in skills as content

**Status:** Accepted, amended by [RFC-0003](../../rfcs/0003-agent-revisions-and-production-deployment.md) · **Date:** 2026-07-29 · **Extends:** ADR-0006 (fs reframe), ADR-0012
(FS-backed skills), ADR-0013 (persistent backends) · **Scopes:** RFC-0001 (file-based agents)

> RFC-0003 preserves the decision to treat skills as versioned content, but replaces mutable
> production reads with immutable published Agent Revisions and per-thread pins. Mutable files are
> draft or workspace state, not executable production configuration.

## Context

A three-way source review (2026-07-28/29) compared our filesystem and skills primitives against
`vercel/eve` @ `082dfed` and `cloudflare/agents` @ `413011e`.

**The lineage in ADR-0013 is confirmed, and understated.** Our `FileSystem`
(`packages/core/src/types/filesystem.ts:39-59`, 19 methods) matches `@cloudflare/shell`'s
`FileSystem` (`packages/shell/src/fs/interface.ts:52-74`). Their durable `Workspace`
(`packages/shell/src/filesystem.ts:222`) — a flat path-keyed SQLite table with `parent_path`
indexed, an `inline|r2` storage column and a 1.5MB spill threshold — is the design we re-derived in
`SqlFileSystem`. What ADR-0013 did not record is that they carry a **second** interface,
`StateBackend` (`packages/shell/src/backend.ts:275-368`, 45 methods: JSON ops, tree-walk,
archive/hash, and `planEdits`/`applyEditPlan`/`applyEdits`), and it is that one — not the 19-method
`FileSystem` — that they expose to the model.

**Two destinations are available, and both peers chose the other one.** Cloudflare invests in a rich
state API driven by a single code-execution tool (`packages/codemode`); Eve has no virtual
filesystem at all, only a sandbox — a real machine behind four backends — with five discrete file
tools. Both are building toward *"agents get a workspace"*. ADR-0006 already declined that
destination by narrowing `@kuralle-agents/fs` to three jobs: the substrate skills mount on, bundled
local files, and a writable scratch.

**Our skills implementation is the most spec-conformant of the three.** We enforce the Agent Skills
name charset, the 1024-character description cap, reserved vendor words, and an XML-tag ban on
frontmatter (a prompt-injection seam, since frontmatter reaches the system prompt). Eve enforces
none of these and additionally *rejects* the spec's own `compatibility` and `allowed-tools` keys,
dropping any skill that uses them. Two of three frameworks refuse to execute skill scripts; ours is
the majority position (ADR-0012).

**Two measured deficits, both ours alone.** `fsSkillStore` has no cache — `list()`, `loadBody()` and
`loadResource()` each re-walk every root and re-parse every `SKILL.md`
(`packages/core/src/skills/fsSkillStore.ts:60-108`). And a malformed skill is `console.warn` + skip
on list, silent skip on load (`:97-103`) — it vanishes. Cloudflare caches via a registry snapshot;
Eve bakes static skill bodies into its compiled manifest so a body load costs zero I/O, and turns a
bad frontmatter block into a typed diagnostic that gates the build.

## Decision

### A. The filesystem is finished. Freeze it.

`FileSystem` stays at **19 methods**. The `workspace` tool stays at **seven ops**
(`ls|cat|grep|find|read|write|edit`, `packages/core/src/tools/fs/createFsTool.ts:35`), read-only by
default, with the existing caps (`caps.ts:1-5`). Neither grows.

The filesystem is a substrate, not a product. Every method added is surface area serving the
workspace destination we declined in ADR-0006. Our caps (2000 lines / 50KB) match Eve's numbers
arrived at independently, which is evidence the shape is right.

### B. Skills are the investment: durable, versioned, hot-updatable content

The end state: **an agent's know-how ships as versioned content — updatable without a deploy,
identical on Node and Cloudflare, and auditable after the fact — while its procedure (flows) and its
boundaries (policy, tool scope) stay in code.**

Five increments, in order:

1. **Fail loud.** A skill that fails to parse is an error carrying its path and reason, not a
   warning and a disappearance. Content that silently vanishes cannot be trusted as behaviour.
2. **Cache the store, keyed on a content hash** — not a timestamp. Without this, runtime loading on
   DO SQLite costs a full re-scan per call.
3. **One runtime source wired end to end** — `fsSkillStore` over `sqlFileSystem` on Cloudflare, with
   a documented write path. Both halves already ship and are separately live-deployed
   (`apps/playground/fs-demo-cf/src/index.ts:28-53`).
4. **Record the content hash on the run span.** The cache key from (2) *is* the audit value — one
   mechanism, two jobs. This closes the "the live prompt is in neither git nor the trace store" hole.
5. **`fsInstructions(fs, path)` as a supported helper.** Instructions are content too, and the
   `Instructions` function branch (`agentConfig.ts:19-22`) already makes this a three-liner. Formalise
   the pattern rather than leaving it a trick.

### C. Reimplement from these — pointers, not paste

Both peer repos are licensed. Reimplement from the design; do not copy source.

| Take | Where to read it | Replaces / why |
|---|---|---|
| Typed diagnostic that gates, instead of a vanishing skill | eve `packages/eve/src/discover/skills.ts:236-253` (`DISCOVER_SKILL_FRONTMATTER_INVALID`) | our `fsSkillStore.ts:97-103` |
| Zero-I/O body load — bodies resolved from a compiled manifest | eve `runtime/framework-tools/skill.ts:43-46` | the strongest form of increment (2) |
| Per-session probe cache keyed on the session object | eve `shared/skill-paths.ts:8,32-43` | cheap cache shape for increment (2) |
| Catalog snapshot for the prompt tier | cloudflare `packages/agents/src/skills/registry.ts:155` | our catalog rebuilds per call |
| Object-storage-backed runtime skill source | cloudflare `packages/agents/src/skills/` (R2 source) | the reference for increment (3) |
| Frontmatter parsing must never `eval` | eve `internal/helpers/gray-matter.ts:17-51` (disables gray-matter's `js` engines) | a trap for any future YAML-library swap |
| No silent fallback — throw when the substrate is absent | eve `execution/sandbox/require-sandbox.ts:16-33` | our workspace tool with no `fs` should throw, not no-op |
| Fail-fast when two instances disagree on shared-store config | cloudflare `packages/shell/src/filesystem.ts` (`Workspace` constructor) | drift on a shared `{sql, namespace}` |
| Injectable runner for a dangerous capability | cloudflare `run_skill_script` + `SkillScriptRunner` | the shape **if** ADR-0012's no-scripts position is ever reversed |
| Read-before-write + SHA-256 stale-write detection | eve `runtime/framework-tools/` (`write_file`) | **deferred** — correctness guard, but our workspace is read-only by default |

### D. Declined, with the reason

- **`StateBackend`'s 45 methods, including multi-file edit planning** (cloudflare
  `packages/shell/src/backend.ts:275-368`) — serves the workspace destination. We are not a coding
  agent.
- **Code-mode: one general execution tool over a typed API** (cloudflare `packages/codemode`) —
  inverts our thesis. Kuralle's argument is enforcement at the tool boundary and SOP in flows; a
  general execution surface is the opposite bet. Good answer to their problem, wrong for ours.
- **Sandbox-as-filesystem** (eve, four backends) — same reason.
- **RFC-0001's file convention and Cloudflare codegen** — only its `prose: runtime` half points at
  the end state in (B); the directory convention and worker codegen serve authoring ergonomics, a
  different destination. Parked at `scope` pending a real driver (multi-tenant prompts, or many
  near-identical agents). The runtime-content work does not depend on them.

## Consequences

- The filesystem stops being a place we spend. Its interface, its tool and its caps are settled.
- Skills become the framework's answer to "change behaviour without a deploy" — a capability neither
  peer fully has: Cloudflare's R2 source is updatable but has no audit story and is CF-only; Eve
  bakes skills at build, so they cannot change without a redeploy.
- Increment (4) makes a `prose: runtime` claim honest. Without it, a replayed trace no longer
  reproduces the run that produced it.
- We keep the strictest Agent Skills conformance of the three, and keep ignoring unknown frontmatter
  keys — which the spec requires and Eve gets wrong.
- RFC-0001 loses roughly two-thirds of its scope. What survives is smaller, and points somewhere.

## Non-goals / rejected

- **Growing `FileSystem` or the `workspace` tool** — see (A). Revisit only if write-enabled
  workspaces become the common case, and then only for the stale-write guard.
- **Executing skill scripts** — ADR-0012's position stands; (C) records the shape to adopt if it is
  ever revisited.
- **Prompt composition as context blocks** (cloudflare `packages/think`, `think.ts:5641-5779`) and
  **turn-level idempotency via a deterministic token** (eve `execution/turn-workflow.ts:64-93`) are
  both relevant to Kuralle and both out of scope here — they belong to prompt-composition and
  durability decisions respectively, not to the fs/skills primitives.
