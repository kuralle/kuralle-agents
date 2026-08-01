# Session handoff — flow enforcement, tool scope, loop latency

Kuralle (`@kuralle-agents/*`). Written 2026-07-28.

## Where things stand

**`main` @ `9fc2d79`** — clean, 822 core tests pass, `typecheck:all` green. Nothing pushed.

| commit | what |
|---|---|
| `404fb33` | 17 tasks: per-node `toolScope`, framework-owned loop exits, `llm` spans, collect-livelock bound, tool-table unification |
| `d220c8d` | changeset describing 0.19.0 — **release deliberately held**, version still 0.18.0 |
| `7fc124f` | mid-flow asides answered instead of escalating to a human |
| `9fc2d79` | `RecoverableToolError` can carry user-facing copy |

**`feat/binding-flow-entry` @ `a9ef56d`** — unmerged and **unsafe**. See "In flight" below.

Read the commit messages for detail; they carry the reasoning and the measurements. Don't
re-derive them.

## The central finding

**Flow entry is model-discretionary, and the model reliably declines to route.**

Measured: an agent whose *only* tool was `enter_flow` still conversed for four turns,
gathered every field itself, and entered the flow once nothing was left to collect. Ten
model calls outside the flow, one inside.

Consequence: a `collect` node's Zod schema, `required`, `maxTurns` and deterministic `ask`
almost never execute. In a clinic-intake probe `dob: z.string().regex(...)` never ran once —
"yesterday" was rejected by the model's judgement, not the schema — and the agent invented
clinic opening hours in the gap.

**So `collect` is presented as enforcement and is not.** That is the defect. Not "flows are
broken" — `action` nodes enforce correctly, because they're unreachable except through the
flow. `collect` competes with free conversation and loses.

Peer positions, verified from source (clones under
`/private/tmp/claude-501/.../scratchpad/peers/`):

| | who decides a node runs |
|---|---|
| LangGraph, Pipecat Flows | the graph / framework — model cannot bypass |
| ElevenLabs, **Kuralle** | the model, via a tool + natural-language conditions |

Model-driven entry is legitimate and production-proven. The defect is pairing it with a
destination we describe as validating.

## In flight — codex dispatch, running now

Worktree: `/private/tmp/claude-501/.../scratchpad/codex-binding` (branch
`feat/binding-flow-entry`, built, `.env` present).
Brief: `GOAL.md` in that directory. Log: `worker-binding.log`. Result contract:
`runs/result-binding.json`.

**Task**: finish `Flow.binding` — entry before the model's turn, correct parking, no cascade,
no unrequested side effect; decide the right digression trigger.

**Why it's needed**: marking `raise_work_order` binding and running live produced a cascade
into a *second* flow and **dispatched a vendor for a work order that did not yet exist**.

**Root cause (mine — codex is told to verify, not trust it)**: `collectUntilComplete` uses
`!advanced` (extraction gained no fields) as its proxy for "user went off-script", then calls
the router with the active flow excluded. Binding entry starts with nothing collected, so
`!advanced` is trivially true and the router picks the next-best flow.

**Do not repeat**: gating digression on first-pass breaks 5 `H5 in-flow digression` tests
that encode intended behaviour.

When it returns: stage first, then verify claims by re-running them, read the diff, and
reproduce the discrimination yourself. A worker's summary is intent, not fact.

## Open decisions (yours, not the agent's)

1. **Release 0.19.0** — held at your instruction. Changeset committed, version not bumped.
   `pnpm changeset version` produced 0.19.0 correctly (the historic 1.0.0 trap did not fire).
   Run `bun install` before gating — `changeset version` runs `pnpm install` and breaks
   `typecheck:all` otherwise.
2. **Item 1 of the recommendation is still undone**: docs and types imply `collect` enforces
   things. With `binding` off that's false; with it on it's true. Conditionally-true is worse
   than uniformly-false unless written down.
3. **Pre-flow phasing** — 4 of 6 dispatch calls happen before the flow, and they are
   *redundant*, not dependent: `find_vendor` runs twice with byte-identical arguments, the
   second time deterministically inside the flow. Design doc exists on the Plan Desk board;
   its framing ("route faster") is wrong and should be rewritten as "prevent exploration".

## Board (Plan Desk, project `53884329-347e-4aa1-9c72-914f800b6970`)

17 tasks `done`. Six `scope` items from this session — pre-flow phasing, abandoned-request
cancellation, `RecoverableToolError.invalidates`, user-facing recovery copy, prompt-cache
variance, strict-mode text emission — plus `f792da79` whose validation contract is
unsatisfiable as written. Nine older `scope` items predate this work; leave them out of any
"before release" framing.

Two documents worth reading before touching the loop:
`Investigation: How seven agent frameworks end a tool loop` and
`Design: Give the flow graph a vote before the model explores`.

## Measurement, so you don't re-derive it

- Turn cost ≈ **round-trips × ~1.5 s**. Per-call latency is uniform (n=33, p50 1464 ms) and
  independent of prompt size. **Count calls, not milliseconds** — wall-clock carries a 3.3×
  provider spread.
- Call counts are deterministic where structure controls them: direct 2, intake 3, dispatch 6.
  Every observed deviation was in pre-flow, where the model has discretion.
- Context growth does **not** drive latency: over 30 turns, `corr(inputTokens, latency)` was
  **+0.02**. Output length correlates 15× more strongly (+0.33).
- Prompt-cache hit rate swings **57–96% on byte-identical prompts** — provider-side warmth,
  not our prefix. The earlier "93.20%" figure was a warm-path number.

Harness: `runs/measure*/` and the script pattern in the commit history. `--store` writes
`*.traces.json`, one JSON object per line.

## Things that bit me — don't repeat them

- **`git checkout -- <path>` destroyed my own uncommitted work.** Fix mistakes by editing
  files back. This is in every worker brief and I still did it.
- **Unit tests on fabricated configurations prove nothing about wiring.** Three defects
  shipped with passing tests: a hand-built `TextDriver` that `Runtime` never constructs, a
  single-field collect where the bug needs two, a speaking-only turn where the bug needs a
  control call. Prefer `createRuntime` + `runtime.run`.
- **Unreachable code doesn't fail, it waits.** Fixing the digression ordering immediately
  exposed a `ctx.globalTools as ReplyNode['tools']` cast that had always been wrong.
- **Workspace packages import `dist/`, not `src/`.** Rebuild after editing `packages/core/src`.
- Root `bun run build` omits `packages/core` in a detached worktree — build it directly.
- ElevenLabs docs 404 on normal URLs but resolve as `.md`.

## Suggested skills

- **`factory-foreman`** — for anything board-driven: groom, dispatch, verify, commit at the
  lane gate. It is the default operating mode for this repo.
- **`diagnose`** — before any fix to the flow engine. Phase 1 (build a deterministic loop)
  is what made every real finding this session; live runs are too noisy to debug against.
- **`tdd`** — red before green, and prove each test discriminative by breaking the fix.
- **`delegate-review`** — codex, a different model family from the author. It caught three
  defects that four Cursor dispatches and my own verification all missed.
- **`curator-plan-writer`** / **`curator-intake`** — for the pre-flow RFC rewrite.
- Skip `build-for-one` and `zero-tech-debt` here; the direction is already settled and the
  remaining work is corrective.

## If you do one thing

Verify the codex dispatch when it lands, and **do not merge `feat/binding-flow-entry` until
the live repro passes**. Its unit tests pass today and the feature still dispatches a vendor
for a job that doesn't exist. That gap between "tests green" and "works" is the whole lesson
of this session.
