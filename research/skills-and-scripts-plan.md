# Kuralle Skills + Scripts — Plan

## 1. Thesis

An **Agent Skill** (Anthropic's standard) is *a folder, not a tool*: a `SKILL.md` with YAML frontmatter + a markdown body, optional read-on-demand reference files, and optional bundled scripts — surfaced to the model by **progressive disclosure** (only `name`+`description` are always loaded; the body loads when relevant; resources load only when read). Flue and Pi both implement exactly this folder+frontmatter+disclosure shape; they differ only in *where the bytes live* (Flue bakes them into the bundle for Cloudflare; Pi walks a real `node:fs` directory). Kuralle should adopt the canonical concept but make two grounded substitutions forced by its constraints: (a) skill bytes must resolve through a **portable `SkillStore`** (Node FS *or* Cloudflare bundled/KV), mirroring the existing `SessionStore` Memory/Redis/Postgres pattern, because there is no POSIX FS on Workers; and (b) a skill's "script" must reference a **pre-registered durable effect tool / flow by name**, not an embedded `bash` command, because Kuralle has no portable shell and its design rules forbid open-ended execution (`CLAUDE.md`: "Tools return data only", "SOP lives in flows"). The wiring already has a precedent in-tree: `AutoRetrieveCapability` already turns a knowledge base into an *on-demand* `search_knowledge_base` tool (`capabilities/AutoRetrieveCapability.ts:23-40`) — skills are the same move, generalized to bundled procedural knowledge.

### TL;DR proposed changes

- **New package `@kuralle-agents/skills`** (`packages/kuralle-skills/`) — `defineSkill()`, the `Skill`/`SkillStore` types, a `MemorySkillStore` + `FsSkillStore` (Node) + `BundledSkillStore` (CF), a `parseSkillMarkdown` frontmatter parser, and a `SkillsCapability` that wires progressive disclosure into the run loop.
- **One new `AgentConfig` field: `skills?: SkillSource[]`** (`types/agentConfig.ts`) — accepts inline `defineSkill({...})` objects or a `SkillStore`. No other config surface.
- **Progressive disclosure via the existing `Capability` seam** (`capabilities/index.ts:78`) — Level 1 (`name`+`description`) → `PromptSection`; Level 2 (body) + Level 3 (resources) → an on-demand `load_skill` / `read_skill_resource` `ToolDeclaration`, copying the `AutoRetrieveCapability` design verbatim.
- **"Scripts" = `defineTool` effect tools / flows referenced by name** — a skill declares `allowedTools` (reuse the `globalTools` allow-list mental model, `agentConfig.ts:28-33`); the body says *"run the `lookup_order` tool"*, resolved to a gated durable effect, never `bash`.
- **No bash, no VFS dependency for the common path.** Skills ride *on* the VFS from the filesystem plan only when a `FsSkillStore` is chosen; the default `MemorySkillStore`/`BundledSkillStore` need no filesystem and run identically on Node and Workers.

---

## 2. What is a Skill / what is a Script

**Skill (canonical, Anthropic).** The smallest valid skill is a directory whose name matches a `name` field and contains one `SKILL.md` (YAML frontmatter + markdown body). Everything else — `reference.md`, `FORMS.md`, a `scripts/` dir — is optional and loaded on demand (anthropics/skills; platform.claude.com best-practices "Runtime environment"). It is *procedural memory*: a bundled, replayable unit of "how to do this workflow", composed *over* tools/MCP, not competing with them (transcript `_sources/transcripts/sSqzg_W8OnA.txt`: function-calling → MCP → Skills).

**Progressive disclosure — three levels** (platform.claude.com best-practices):
1. **Metadata, always loaded** — at startup only every skill's `name`+`description` enter the system prompt (~100 tokens, ≤1024 chars). This is the discovery key across 100+ skills.
2. **Body, loaded on trigger** — `SKILL.md`'s markdown read only when the skill becomes relevant; a table of contents pointing outward (<500 lines).
3. **Bundled files, loaded as needed** — `reference.md` etc. cost zero context until a read touches them; kept one level deep.

**Script (canonical).** A pre-bundled executable (`scripts/analyze_form.py`) that the model *runs* via the bash tool when an operation is **deterministic, fragile, or repeated** — more reliable than generated code, token-free (only output enters context), consistent across runs (platform.claude.com best-practices "Provide utility scripts"). The authoring distinction is load-bearing: **"Run `x.py`"** (execute) vs **"See `x.py`"** (read as reference). The execution surface is an open shell in a code-execution sandbox — which is *the* security surface (prompt injection, exfiltration; transcript `_sources/transcripts/bxjmFlopZqc.txt`, the reason OpenClaw runs on a sandboxed VPS). The Claude *API* has no network/runtime-install; claude.ai does (platform.claude.com best-practices).

**Why Kuralle cannot adopt "script = bash" verbatim.** Kuralle runs on Node/Bun *and* Cloudflare Workers/DO — there is no portable shell. Its tool primitive `defineTool({name,description,input:zod,execute})` (`tools/effect/defineTool.ts:13-47`) is a *narrow-schema durable effect* (effect-log, exactly-once on retry) — the deliberate opposite of an open shell. And the project's non-negotiable rules (`CLAUDE.md`) are "Tools return data only" and "SOP lives in flows, not prompts". So the Kuralle-native "script" — the deterministic/fragile/repeated unit a skill should *run* — is **an effect tool or a flow, referenced by name**, not a bundled `.py`.

---

## 3. SKILL.md schema comparison (Flue vs Pi vs Anthropic canonical)

| Field | Anthropic canonical | Flue | Pi |
|---|---|---|---|
| `name` | required, ≤64, `[a-z0-9-]`, no reserved `anthropic`/`claude`, **= dir name** | required, ≤64, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, = dir name (`skill-frontmatter.ts:40-41`, `:66-80`) | required, ≤64, `^[a-z0-9-]+$`, no double/edge hyphen, = parent dir (`harness/skills.ts:281-291`); falls back to dir name |
| `description` | required, non-empty, ≤1024, third-person, states *what+when* | required, non-empty, ≤1024 (`skill-frontmatter.ts:42-47`) | required, ≤1024; empty → skill silently dropped (`skills.ts:265-267,293-301`) |
| `license` | seen in wild | optional (`skill-frontmatter.ts:49`) | — |
| `compatibility` | seen in wild | optional, ≤500 (`skill-frontmatter.ts:50-53`) | — |
| `allowed-tools` | per-skill tool allow-list | optional, whitespace-split → `string[]` (`skill-frontmatter.ts:62`) | — |
| `metadata` | free-form | optional string→string map (`skill-frontmatter.ts:61,99-113`) | — |
| `disable-model-invocation` | — | — | optional; exists only for explicit `/skill:` (`types.ts:46-57`, `harness/system-prompt.ts:4`) |
| **body** | the SKILL.md markdown after frontmatter | parsed as `body` (`skill-frontmatter.ts:3-11`) | parsed as `content`, re-read lazily in coding-agent (`skills.ts:74-81`) |

**Consensus required pair:** `name` + `description` only. Everything else is optional. Both implementations validate name/description, agree on the ≤64 / ≤1024 limits, and agree name must equal the directory name.

---

## 4. Deconstruction to primitives

The smallest reusable interfaces, ordered by how much Kuralle needs them:

**P1 — `Skill` (data shape).** `{ name, description, body, resources?, allowedTools? }`. Flue's parsed form: `{ name, description, body, license?, compatibility?, metadata?, allowedTools? }` (`skill-frontmatter.ts:3-11`). Pi's portable form: `{ name, description, content, filePath, disableModelInvocation? }` (`types.ts:46-57`). The irreducible core both share: **name + description + body**, with the body *not* in the prompt by default.

**P2 — `SkillStore` (source abstraction).** Where the bytes live, behind one interface: list metadata (cheap), load a body, load a resource. This is the portability keystone. Flue has *two* sources behind one in-prompt shape: workspace (live sandbox fs, `context.ts:43,57`) and packaged (base64 bundled, served via a read-tool overlay, `agent.ts:60-101,486-501`). Pi's portable harness factors this as an injected `ExecutionEnv` (`fileInfo/listDir/readTextFile/canonicalPath`, `harness/skills.ts:49-75`) — **no `node:fs` import in the portable layer**; only `coding-agent/core/skills.ts` imports `node:fs` directly. So the proven pattern is: *abstract the source; one impl per runtime.*

**P3 — progressive disclosure (3 levels).** Inject only `name`+`description` (Level 1); load body on trigger (Level 2); load resources on read (Level 3). Flue: `<skill_instructions>` body + `<skill_resources>` list of `read <path>` pointers (`result.ts:33-67`). Pi: `<available_skills>` with only name/description/location, body read via the `read` tool — and the block is emitted *only if a `read` tool exists* (`harness/system-prompt.ts:3-25`, `core/system-prompt.ts:71`).

**P4 — activation paths.** (a) **Model-decided** — model reads/loads the skill when its description matches. (b) **Explicit** — Flue `session.skill(ref)` (`session.ts:889-918`); Pi `/skill:<name>` pastes the full body as a user message (`agent-session.ts:1173-1197`). Pi's `disable-model-invocation` makes a skill *only* explicit. Neither system turns a skill into a tool-per-skill — skills are **prompt pointers**, never synthesized tools.

**P5 — script execution.** Neither Flue nor Pi has a bespoke script engine. Flue: resource files are advertised, read on demand via a read-tool overlay (`agent.ts:91-94`); the bash sandbox is a *separate, swappable* primitive (`with-custom-bash.ts`). Pi: scripts run through the generic `bash` tool, anchored by an injected skill-dir/`baseDir` + an explicit relative-path-resolution instruction (`harness/system-prompt.ts:10`). **The script primitive = (an executor) + (a way to tell the model the absolute/qualified handle).**

### Comparison table

| Primitive | Anthropic canonical | Flue | Pi | Kuralle today | Kuralle proposed |
|---|---|---|---|---|---|
| Skill data shape | folder + `SKILL.md` | `PackagedSkillDirectory`/`SkillReference` (`types.ts:196-222`) | `Skill` (`types.ts:46-57`) | — none | `Skill` (P1) |
| Source abstraction | filesystem | workspace fs *or* base64 registry | injected `ExecutionEnv` | `SessionStore` (analog) | `SkillStore` (P2) |
| 3-level disclosure | yes | yes (`result.ts:33-67`) | yes (`system-prompt.ts:3-25`) | partial: `AutoRetrieveCapability` on-demand tool (`AutoRetrieveCapability.ts:23-40`) | `SkillsCapability` (P3) |
| Explicit invocation | install/run | `session.skill()` | `/skill:` | — | optional slash/`runtime.run` flag |
| Script executor | bash sandbox | swappable `Bash` (`with-custom-bash.ts`) | generic `bash` tool | `defineTool` effect / flow | **effect tool / flow by name** (P5) |
| Per-skill tool allow-list | `allowed-tools` | `allowed-tools` (`skill-frontmatter.ts:62`) | — | `globalTools` allow-list (`agentConfig.ts:28-33`) | `Skill.allowedTools` |

**Portability verdict.** Portable (Node + Workers): P1, P3, P4, and P2's *memory/bundled* impls (bytes baked in, served from memory — Flue proves this works on `--target cloudflare`, README:14-21). Runtime-specific: a `FsSkillStore` (needs the VFS from the filesystem plan) and any build-time `import ... with { type: 'skill' }` packaging (Flue's Vite plugin, `vite-skill-reference-plugin.ts:140-205`) — replaceable in Kuralle by an inline `defineSkill({...})` literal, removing the only bundler-specific piece.

---

## 5. Proposed Kuralle design

**Copy Pi's portable harness layering** (injected source abstraction + prompt-pointer disclosure, no `node:fs` in core) **and Flue's bundled-bytes idea** (memory store works on Workers), and **reuse Kuralle's own `AutoRetrieveCapability`** as the literal template for wiring on-demand loading. Substitute "script = bash" with "script = effect tool / flow by name". Nothing speculative beyond this.

### 5.1 New package `packages/kuralle-skills/` (`@kuralle-agents/skills`)

```
packages/kuralle-skills/src/
  defineSkill.ts        # defineSkill(config): Skill  (mirrors defineTool/defineAgent)
  types.ts              # Skill, SkillSource, SkillStore, SkillMetadata
  parseSkillMarkdown.ts # frontmatter parser, ported from Flue skill-frontmatter.ts
  stores/
    MemorySkillStore.ts   # inline defineSkill({...}) objects — Node + CF
    BundledSkillStore.ts  # base64/manifest map — Node + CF (Flue packaged-skill analog)
    FsSkillStore.ts       # reads <dir>/<name>/SKILL.md via the VFS — Node (and CF only if VFS present)
  SkillsCapability.ts   # progressive disclosure → PromptSection + load_skill/read_skill_resource tools
  index.ts
```

Kept out of `kuralle-core` deliberately: skills are an optional capability (like `realtime-audio`), and `FsSkillStore` would otherwise drag a VFS dependency into core.

### 5.2 The primitives (minimal)

```ts
// types.ts
export interface Skill {
  name: string;            // required, ≤64, [a-z0-9-], = store key
  description: string;     // required, ≤1024, third-person "what + when"
  body: string;            // Level-2 payload; NOT in the prompt by default
  resources?: Record<string, string>;  // Level-3: relpath -> content (lazy)
  /** Allow-list of effectTool/flow names this skill may reference. */
  allowedTools?: string[];
}

export interface SkillMetadata { name: string; description: string; }

export interface SkillStore {
  list(): Promise<SkillMetadata[]>;          // Level 1 — cheap, always
  loadBody(name: string): Promise<string>;   // Level 2 — on trigger
  loadResource(name: string, path: string): Promise<string>; // Level 3 — on read
}

export type SkillSource = Skill | Skill[] | SkillStore;
```

`defineSkill` is a pass-through validator (exactly like `defineAgent` at `agentConfig.ts:53-55` and `defineTool`). `MemorySkillStore` wraps `Skill[]`; `FsSkillStore` parses `<dir>/<name>/SKILL.md` + sibling files via the VFS (the filesystem plan's store), reusing `parseSkillMarkdown` (ported from `skill-frontmatter.ts:18`).

### 5.3 The one `AgentConfig` field

```ts
// types/agentConfig.ts — add ONE field
  /** Bundled procedural skills (Anthropic Agent Skill model): progressive
   *  disclosure of name+description (always) → body (on trigger) → resources
   *  (on read). A skill may only reference effectTools/flows it allow-lists. */
  skills?: SkillSource;
```

No `scripts` field — scripts are existing `effectTools`/`flows` referenced by a skill's `allowedTools`.

### 5.4 Progressive disclosure via the `Capability` seam (copy `AutoRetrieveCapability`)

`SkillsCapability implements Capability` (`capabilities/index.ts:78`):

- **Level 1** → `getSections(): PromptSection[]` returns one `{ role: 'context', content }` block listing every skill's `name`+`description` (from `store.list()`). This matches how Pi gates the block and where Kuralle already injects context (`capabilities/index.ts:34` ordering; ADR 0001 base-layer precedent).
- **Level 2 + 3** → `getTools(): ToolDeclaration[]` returns two on-demand tools, structurally identical to `search_knowledge_base` (`AutoRetrieveCapability.ts:34-40`):
  - `load_skill({ name })` → `store.loadBody(name)`; result returns the body wrapped `<skill name location>…</skill>` (Pi's wrapper, `agent-session.ts:1186`) so relative references resolve against the skill.
  - `read_skill_resource({ name, path })` → `store.loadResource(name, path)`.

This is the keystone: **no always-loaded skill bodies** (Kuralle's "buffer/gate, don't dump context" discipline), and it reuses an in-tree, tested pattern rather than inventing a loader.

### 5.5 Scripts = durable effect tools / flows by name

A skill body says **"To look up an order, run the `lookup_order` tool with the order id."** `Skill.allowedTools` declares `['lookup_order']`. At wire time `SkillsCapability` validates that each listed name exists in the agent's `effectTools`/`globalTools`/flows and exposes *only* those — reusing the `globalTools` allow-list posture verbatim (`agentConfig.ts:28-33`: "explicit allow-list; NEVER put consequential/mutating tools here unless flow-gated"). The deterministic/fragile/repeated operation runs as a `defineTool` effect (exactly-once via the effect log, `defineTool.ts:13-47`) or a flow — preserving "tools return data only; flow control via transitions".

### 5.6 Node vs Cloudflare portability

| Concern | Node/Bun | Cloudflare Workers/DO |
|---|---|---|
| Default store | `MemorySkillStore` (inline `defineSkill`) | `MemorySkillStore` — identical, bytes in bundle |
| Bundled store | `BundledSkillStore` (manifest) | `BundledSkillStore` — bytes baked in, no fs (Flue proves: README:14-21) |
| FS store | `FsSkillStore` over the VFS / local dir (drop-in compatible w/ `anthropics/skills` folders) | only if a VFS backing (R2/KV/DO-SQLite) is wired per the filesystem plan |
| Capability + disclosure | pure string + `ToolDeclaration` — portable | identical (no fs touched) |
| Script execution | `effectTool.execute` | identical — effect tools are runtime-neutral |

The default (`MemorySkillStore` + `SkillsCapability`) has **zero fs dependency** and runs byte-identically on both runtimes — the same property that makes Flue's packaged skills work on Workers, achieved without a Vite plugin by using an inline literal.

---

## 6. Use-case walkthrough — customer-support agent

A support agent with a local returns-policy knowledge base, plus a "lookup-order" script.

**1. The "script" is a durable effect tool (data only):**

```ts
// tools.ts
export const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Fetch order status, items, and dates for an order id.',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => db.orders.get(orderId),   // returns data, no prose
});
```

**2. The "returns-policy" skill (folder analog, here inline so it ships to Node *and* CF):**

```ts
// skills/returns-policy.ts
export const returnsPolicy = defineSkill({
  name: 'returns-policy',
  description:
    'Explains the 30-day return window, refund timelines, and exceptions. ' +
    'Use when the customer asks about returning, refunding, or exchanging an order.',
  allowedTools: ['lookup_order'],
  body: [
    '# Returns policy',
    '1. Confirm the order id, then run the `lookup_order` tool.',
    '2. If the order is < 30 days old, it is returnable — see `exceptions.md` for non-returnable categories.',
    '3. State the refund timeline (5–7 business days to the original method).',
  ].join('\n'),
  resources: {
    'exceptions.md': '# Non-returnable\n- Gift cards\n- Final-sale items\n- Perishables',
  },
});
```

**3. Wiring — one new field:**

```ts
export const supportAgent = defineAgent({
  id: 'support',
  model,
  instructions: 'You are a calm, precise support agent.',
  effectTools: { lookup_order: lookupOrder },
  skills: [returnsPolicy],          // <-- the only new surface
});
```

**Runtime behavior (progressive disclosure):**
- **Turn 1** — only `returns-policy: Explains the 30-day return window…` is in the prompt (Level 1). The body and `exceptions.md` are *not* loaded.
- Customer: *"Can I return order A123?"* → model calls `load_skill({ name: 'returns-policy' })` (Level 2); the body enters context for this turn.
- Following the body, the model calls `lookup_order({ orderId: 'A123' })` (the "script" — a gated durable effect, exactly-once).
- For a gift card it calls `read_skill_resource({ name: 'returns-policy', path: 'exceptions.md' })` (Level 3) — loaded only now.

**Local knowledge base, larger corpus:** for a policy *corpus* rather than one skill, keep using `AgentKnowledge` + `AutoRetrieveCapability`'s `search_knowledge_base` (`grounding.ts`, `AutoRetrieveCapability.ts`) — skills and retrieval coexist: skills are *procedural* ("how to handle a return"), knowledge is *referential* ("the full 40-page policy"). The thesis maps each to the right primitive rather than forcing one.

**Cloudflare:** the exact same code deploys to `@kuralle-agents/cf-agent` — `MemorySkillStore` carries the bytes in the bundle; no fs, no Vite plugin, no `wrangler` change.

---

## 7. Open questions

1. **Explicit invocation surface.** Do we need Pi's `/skill:<name>` (paste body as user message, `agent-session.ts:1173-1197`) and `disable-model-invocation`, or is model-decided `load_skill` enough for conversational agents? Recommend: ship model-decided only; add explicit invocation only if a flow node wants to *force* a skill.
2. **Flow integration.** Should a flow node be able to attach a skill (node-scoped disclosure), mirroring node-scoped grounding (MEMORY: "node-scoped grounding > global prompt")? Likely yes as a follow-up; out of first scope.
3. **Validation severity.** Flue throws on a bad skill name; Pi silently drops an empty-description skill (`skills.ts:265-267`). Pick: throw at `defineSkill` (fail fast, matches `defineTool`'s strictness).
4. **`FsSkillStore` depends on the filesystem plan's VFS** (`research/filesystem-harness-research-scratchpad.md:20` — WF-1 `filesystem-primitives-plan.md` not yet written). The Memory/Bundled default does not block on it; FS store lands when the VFS does.
5. **Runtime authoring ("save this interaction as a skill")** — the super-agent unlock (transcript `bxjmFlopZqc.txt`: dynamic skill remembering). Requires a writable `SkillStore` + a draft/publish path; overlaps the config-loaded-agents overlay (`research/config-loaded-agents-plan.md`). Flag, don't build.

## 8. Risks / non-goals

- **Non-goal: a bash/sandbox script engine.** Kuralle has no portable shell; embedding one is a prompt-injection + exfiltration surface (transcript `bxjmFlopZqc.txt`) and breaks Workers portability. Scripts are effect tools / flows by name. This is the deliberate divergence from the canonical spec.
- **Non-goal: a tool-per-skill.** Skills are prompt pointers, never synthesized tools (matches both Flue and Pi). The only tools added are the two generic `load_skill`/`read_skill_resource` loaders.
- **Non-goal: build-time skill imports** (`with { type: 'skill' }` + a bundler plugin, `vite-skill-reference-plugin.ts`). Inline `defineSkill` + `BundledSkillStore` covers the portable case without a Kuralle-specific bundler step.
- **Risk: skill bodies bloating the prompt if mis-wired.** The whole value is *not* loading bodies at Level 1; a regression that injects bodies eagerly silently defeats the feature. Guard with a test asserting only `name`+`description` appear in the assembled prompt pre-trigger (the existing prompt-assembly tests are the place).
- **Risk: `allowedTools` drift.** A skill body that names a tool not in `allowedTools` (or not registered) should fail at wire time, not at turn time — validate in `SkillsCapability` setup against the agent's tool/flow registry.

---

### Sources

- **Anthropic canonical:** platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices (frontmatter rules, 3-level disclosure, scripts-vs-tools, runtime/security); github.com/anthropics/skills (folder structure); anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills. Transcripts: `research/_sources/transcripts/sSqzg_W8OnA.txt`, `research/_sources/transcripts/bxjmFlopZqc.txt`.
- **Flue:** `research/flue/packages/runtime/src/skill-frontmatter.ts:3-80,99-124`, `result.ts:33-95`, `agent.ts:11,60-101,486-540`, `context.ts:43-113`, `session.ts:219-230,889-918,1114-1151`, `types.ts:196-222`; `packages/cli/src/lib/vite-skill-reference-plugin.ts:140-205`.
- **Pi:** `research/pi/packages/agent/src/harness/{skills.ts,system-prompt.ts:3-25,types.ts:46-57}`; `packages/coding-agent/src/core/{skills.ts:74-81,265-301,335-361,430-436},{system-prompt.ts:71},{agent-session.ts:1173-1238}`.
- **Kuralle:** `packages/kuralle-core/src/types/agentConfig.ts:16-55`, `tools/effect/defineTool.ts:13-47`, `capabilities/index.ts:8-78`, `capabilities/AutoRetrieveCapability.ts:23-40`, `types/grounding.ts`, `runtime/openRun.ts:96-132`. Related plans: `research/deploy-primitives-plan.md`, `research/config-loaded-agents-plan.md`, `research/filesystem-harness-research-scratchpad.md`.
