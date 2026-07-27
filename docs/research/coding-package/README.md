# Research: coding package / software factories

Primary sources behind the two RFCs on the Plan Desk board:

- **Design: @kuralle-agents/coding — the governance layer for software factories** (the argument)
- **Design: @kuralle-agents/coding — engineering plan** (the build)

Gathered 2026-07-26/27. Everything here is either a local copy of a primary source or a
pointer to one. Claims in the RFCs trace back to a row in this file.

---

## Reference implementations

### `owainlewis/neo` — Go, minimalist coding agent harness + orchestrator

https://github.com/owainlewis/neo · Go · MIT · read at 2026-07-27

Design docs copied to [`neo/`](neo/) — these are the highest-signal reads in the whole set.

| file | what it contributed |
|---|---|
| [`architecture.md`](neo/architecture.md) | the module split; "the core agent loop is policy-free" |
| [`agent-loop.md`](neo/agent-loop.md) | the tool_use/tool_result pairing invariant; "add behavior around the loop, not inside it" |
| [`permissions.md`](neo/permissions.md) | the `Policy.Decide` interface we adopted; trusted/ask/readonly; workspace boundary that mode cannot disable; the honest admission that bash is not path-checked |
| [`compaction.md`](neo/compaction.md) | `Compactor` interface; `SafeSplitPoint`; the no-model-catalog decision |
| [`design.md`](neo/design.md) | **parallel subagents** — races solved by making parallel children read-only rather than by worktree isolation; `ParallelSafe` fails closed |
| [`tools.md`](neo/tools.md) | six-tool surface; `edit_file` replaces exactly one occurrence and fails otherwise, so failure is *useful* |
| [`sessions.md`](neo/sessions.md), [`system-prompt.md`](neo/system-prompt.md), [`goal-runner.md`](neo/goal-runner.md) | session store, prompt assembly, goal runner |

Source modules worth reading directly if you go further: `internal/agent/`, `internal/permission/`,
`internal/compact/`, `internal/factory/` (supervisor + runner).

### `vercel-labs/open-agents` — TypeScript, background/cloud coding agents

https://github.com/vercel-labs/open-agents · 5.7k stars · created 2025-12-26, active

Not copied (large monorepo). Clone to inspect. What it contributed:

- **"The agent is not the sandbox"** — the agent runs outside the VM and reaches in through
  tools, so *"the VM stays a plain execution environment instead of becoming the control plane."*
  This is the RFC's `Workspace` design rule.
- `packages/sandbox/interface.ts` — a sandbox seam with **one** implementation (`vercel/`),
  plus lifecycle hooks (`afterStart`, `beforeStop`, `onTimeout`). Precedent for shipping one
  implementation rather than a provider matrix.
- `packages/agent/tools/ask-user-question.ts` — HITL as a *tool* with structured options and a
  `declined` output. Better shape than a boolean.
- `packages/agent/subagents/registry.ts` — `explorer` (read-only) / `executor` / `design`.
  Independent convergence with Neo on read-only children.
- `apps/web/app/workflows/chat.ts` — durability via `"use workflow"` / `"use step"` on the
  Vercel Workflow SDK. **Platform-bound**, which is why the RFC rejects it as our shape.
- Notably has **no** edit tool with type feedback — only `write`. Supports the RFC's claim that
  diagnostics-in-edit is unclaimed.

### `mastra-ai/mastra` — TypeScript agent framework

https://github.com/mastra-ai/mastra

Read via DeepWiki rather than cloned. Contributed the coding-agent comparison: `createCodingAgent`,
`Workspace` + `WorkspaceSandbox` (Local/E2B/Daytona/Railway — the provider matrix we reject),
`string_replace_lsp` returning **LSP diagnostics with the edit result**, `ast_smart_edit` (ast-grep),
`Harness` with plan/build/review modes, ACP subagent delegation.

---

## The category

### Mastra — "How to Build an AI Software Factory with AI Agents in TypeScript"

https://mastra.ai/blog/software-factory · Sam Bhagwat (CEO) · 2026-07-16
Example repo: https://github.com/maniculehq/mastra-software-factory

The canonical definition the RFC uses, and the direct competitor's positioning. Contributed:

- the settled definition of a software factory, and the six functions (triage, code gen,
  validation, release, documentation, monitoring)
- five components: input sources, agents, tools, feedback loops, outputs
- the coordination framing — engineers spend 50-70% of time coordinating, and *that* is what a
  factory automates
- "dark factory" = lights-out, no human in the loop
- **their own "What to Build Next" list** — human reviews, stuck-agent detection, typed work
  items surviving handoffs. All three are governance/durability, and all three are the RFC's wedge.

Caveat recorded in the RFC: it is a blog post plus a partner-authored example repo, **not** a
Mastra product feature. There is no `@mastra/factory` package. The production claim (StrongDM,
Prisma) is uncited.

---

## Practitioner talks

Six transcripts in [`transcripts/`](transcripts/), one file per video id.

Re-fetch any of them with:

```bash
python3 "$HOME/.claude/skills/youtube-researcher/scripts/youtube_research.py" \
  transcript "https://www.youtube.com/watch?v=<ID>" --lang en --mode native
```

| id | what it is | its most useful idea |
|---|---|---|
| [`gTeujlv8qK0`](transcripts/gTeujlv8qK0.txt) | "Architecture of Pi" (Alejandro AO) | sessions as an **append-only JSONL tree** (`id` + `parent`) → fork/clone free; compaction as a *structured checkpoint*; measure context from provider `usage`, never `chars/4`; skills dispatched **by reference**, not inlined |
| [`N30XGyPrr6I`](transcripts/N30XGyPrr6I.txt) | "Pi: getting started" (same) | live demo that a harness with **no permission layer runs `rm -rf` unprompted** — evidence for the Policy work, not an argument for it |
| [`5duo9qHw660`](transcripts/5duo9qHw660.txt) | "Building Tau" (same) | *"this harness itself doesn't even know that it is a coding agent"* — the layering rule the RFC adopts |
| [`IgFe361zRW4`](transcripts/IgFe361zRW4.txt) | Dax Raad (OpenCode / SST) interview | *"we don't do anything impressive or smart in OpenCode… All the magic is in the model"*; the **harness-is-a-commodity** argument; parallel-agent workflows are largely fiction; long-horizon autonomy is a property of the codebase's test suite; provider deployment quality dominates model quality for tool-calling. **The strongest counter-argument to this whole plan — read it if you are about to disagree with the RFC.** |
| [`sIHMOd0awFc`](transcripts/sIHMOd0awFc.txt) | OpenCode source walkthrough | **LSP diagnostics fetched inside the edit tool after the write** and appended to context — the RFC's REQ-3; per-step **git snapshots** via index + write-tree with no commits — REQ-5; plan mode enforced by **withholding edit tools** |
| [`WOOzCHaQipU`](transcripts/WOOzCHaQipU.txt) | "How I use OpenCode" (Keith) | per-task model routing and token budgeting; opens by naming **attention** as the bottleneck, then proposes parallelism as the fix — which `IgFe361zRW4` directly attacks |

**Where they disagree:** `WOOzCHaQipU` demos three concurrent sessions and calls it a
game-changer; `IgFe361zRW4` says those people *"are making it up"* and the constraint is human
attention. Not reconcilable — both sides are recorded rather than averaged, because Unresolved
Question 1 in the RFC turns on exactly this.

---

## Our own evidence

The RFC's motivation is grounded in this repo's artifacts, not in the sources above.

| artifact | what it shows |
|---|---|
| `runs/final.json`, `runs/final.traces.json` | the 35-turn live run against 0.17.0 |
| `grep -c dispatch_vendor_with_approval runs/final.traces.json` → **0** | the agent claimed twice to have requested owner approval and never called the tool (REQ-8's motivating defect) |
| `packages/core/examples/tool-policy-live.ts` | the Policy live probe — read-only agent refuses a write, 0 writes reach execute; proven discriminative |
| commit `dab0dfc` | `Policy` shipped (engineering plan Step 2) |
| commit `ee7a517` | `RecoverableToolError` + escalation hold/resume — the mechanism REQ-3 reuses |
| commit `60ac1c5` | duplicate-work-order guard, the second structural fix |

Three coherence/flow/trace audits were run over the earlier corpus by subagents; their findings
are summarized in the RFC's motivation section and in the board tasks they generated
(`821f01a2`, `9ade5ec8`, `ae9f53b7`, `72d61b31`).
