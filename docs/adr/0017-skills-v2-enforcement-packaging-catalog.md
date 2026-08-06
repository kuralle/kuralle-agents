# ADR 0017 — Skills v2: enforce `allowed-tools`, package into the bundle, freeze-and-announce the catalog

**Status:** Accepted · **Date:** 2026-08-04 · **Context:** a1–a7 skills epic (`7ab3940`…`dc3bdd8`) ·
**Extends:** ADR-0012 (workspace + FS skills), ADR-0016 (FS and skill primitives)

## Context

ADR-0016 froze the filesystem and named skills as the investment: durable, versioned,
hot-updatable content, competitive with `vercel/eve` and `@cloudflare/agents`. The a1–a7 tasks
built that out — a hardened YAML parser, a self-correcting `load_skill`, packaged skills for
Cloudflare, `ctx.getSkill()`, enforced `allowed-tools`, a frozen-baseline catalog, and per-tenant
resolvers. Three of those calls put Kuralle in open disagreement with both reference frameworks
this project tracks (`vercel/eve`, `withastro/flue`), and are worth recording with what the
alternative would have cost.

## Decision

### A. Enforce `allowed-tools` at the tool boundary

Both `eve` and `flue` treat a skill's `allowed-tools` field as descriptive: `eve` goes further and
rejects any skill declaring the spec's own `compatibility` or `allowed-tools` keys outright,
dropping the skill rather than acting on the field (recorded in ADR-0016's source comparison).
Neither peer restricts what a model can call once a skill with that field is active.

Kuralle enforces it: `permittedToolNames` / `skillRestrictionPolicy`
(`packages/core/src/skills/skillActivation.ts`) compute the union of every currently-active
skill's `allowed-tools` plus the framework's own `load_skill`/`read_skill_resource`, and a
`Policy` denies any tool call outside that set. This follows directly from this repo's standing
design rule (see `CLAUDE.md`): *enforce at the tool boundary, not in the prompt* — every safety
property enforced by a tool boundary held under adversarial testing in this project's history;
every property that depended on the model recalling a prompt instruction did not.

This is not adopted as an unconditional security boundary, and the guide says so prominently: the
restriction is *activation-scoped*. It applies only once `load_skill` has succeeded for a
declaring skill; a model that never activates — wrong name, or simply didn't call it — remains
unrestricted. `packages/build/examples/packaged-skills-live.ts` demonstrates both halves live: the
forbidden tool denied once the skill is active, and the same tool succeeding when activation is
skipped. For an unconditional restriction, the existing agent `policy` composes ahead of this one
(deny-wins), which is the answer for callers who need one regardless of model behavior.

**Alternative considered:** match `eve`/`flue` and treat `allowed-tools` as descriptive metadata
only. Rejected — a field the spec defines and Kuralle parses but never acts on is worse than not
having it: an author reads `allowed-tools` in a `SKILL.md` and reasonably assumes it restricts
something.

### B. Package into the bundle, not into a sandbox

`eve` materializes a skill's files into a sandbox (a real machine behind one of four backends) so
skill scripts and file references resolve against a live filesystem at runtime. Kuralle declined
sandbox-as-filesystem entirely in ADR-0016 (non-goal: "we are not a coding agent") and does not
execute skill scripts (ADR-0012).

Given that, a `SKILL.md` folder still needs *some* runtime access path for the model — a1–a7
answered that with `packageSkillsDirectory` (`@kuralle-agents/build`) content-addressing a skill
directory into a `PackagedSkill[]` at build time, and `packagedSkillStore`
(`packages/core/src/skills/packagedSkillStore.ts`) serving `load_skill` /
`read_skill_resource` / `ctx.getSkill()` from that in-memory bundle. No `workspace` filesystem,
and no sandbox, is required to serve a packaged skill at runtime.

This is why Cloudflare parity needed **no special case**: a packaged skill is base64-encoded
strings in a plain object, workerd-clean by construction, with the same code path serving it on
Node, Bun, and Workers. The alternative — requiring a sandbox or a workspace filesystem to resolve
skill content — would have made Cloudflare a second, degraded runtime target for this feature, the
exact outcome ADR-0016 committed to avoiding.

**Alternative considered:** materialize packaged skills into a `workspace` filesystem at boot, the
way `eve` populates its sandbox. Rejected — reintroduces a filesystem dependency for a mode whose
entire point is running without one, and duplicates content that is already fully resolvable from
the bundle itself.

### C. Frozen baseline + in-transcript announcement, not prompt re-rendering

Skills can be added or withdrawn mid-session (`LiveSkillCatalog`,
`packages/core/src/skills/liveSkillCatalog.ts` — a6). The naive approach re-renders the
`## Available skills` block in the system prompt whenever the roster changes, so the model's view
is always exactly current.

Kuralle does not do this. `SkillsCapability.getPromptSections()` renders only the **frozen**
baseline computed at wire time; a roster change is instead delivered as a one-off transcript note
(`renderSkillCatalogDelta`, `packages/core/src/skills/skillCatalog.ts`) naming what was added or
withdrawn and restating the full current roster, and the frozen baseline is folded forward to the
live roster only at compaction — the one point where the cached prompt is already being rewritten
for other reasons.

The reason is prompt caching: the serialized system prompt (tools block included) is a
provider-cached prefix. Editing it mid-conversation invalidates that cache for the rest of the
conversation — every subsequent turn pays full input-token price instead of the cached rate, for
every agent in a potentially long-running session, in exchange for a catalog line the model would
otherwise learn from a two-line transcript note. `load_skill`'s `name` parameter is deliberately
`z.string()` rather than a literal union of known skill names for the identical reason (see the
inline comment in `SkillsCapability.getTools()`): a literal union would need updating on every
catalog change, and *that* union lives in the tool schema, which is part of the same cached
prefix.

**Alternative considered:** re-render the prompt block on every catalog change and accept the
cache invalidation. Rejected as a standing cost for a use case (dynamic mid-session catalog
changes) that is the exception, not the common case — most agents wire a static skill set for the
life of a session.

## Declined

- **Import-as-declaration** (`flue`'s code-first `'use agent'` skill imports — statically scanned
  and packaged by a build-time AST pass, per-bundler). Elegant: a skill is a normal module import,
  and the bundler's own dependency graph does the discovery. Declined because it costs a bundler
  plugin *per bundler*, and Kuralle ships to Node, Bun, and workerd through different build
  pipelines (`@kuralle-agents/build`'s own packager, Wrangler, and Bun's bundler respectively) —
  three plugins to build and keep in sync for a discovery mechanism that `packageSkillsDirectory`
  (a plain directory walk, no bundler integration) already delivers.
- **Sandbox materialization** — declined for the same reason as (B) above and as ADR-0016's
  broader non-goal: Kuralle is not a coding agent, and does not carry the sandbox dependency eve
  does for anything else in the framework.

## Consequences

- `allowed-tools` is real enforcement, but the docs and every example that demonstrates it must
  say "activation-scoped guard-rail," never "security boundary" — overclaiming this is the
  specific failure mode the guide is written to avoid.
- A packaged skill has zero runtime filesystem or sandbox dependency; a filesystem skill still
  requires a `workspace` and pays a directory scan per fresh discovery.
- Mid-session catalog changes are visible to the model as a transcript note, not as a rewritten
  catalog block — anything reading the raw system prompt for the "current" skill roster mid-session
  will see the frozen baseline, not the live one; the live roster is `LiveSkillCatalog.entries()`.
- Kuralle's discovery mechanism (a plain directory walk at build or run time) has no bundler
  coupling, at the cost of not getting a bundler's dependency graph for free the way `flue` does.

## Rejected

- **Descriptive-only `allowed-tools`** (matching `eve`/`flue`) — see (A).
- **Sandbox-backed skill materialization** (matching `eve`) — see (B) and Declined.
- **Prompt re-rendering on every catalog change** — see (C).
- **Import-as-declaration** (matching `flue`) — see Declined.
