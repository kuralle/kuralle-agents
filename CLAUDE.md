# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

Every architectural claim below was checked against source on 2026-07-27. Claims that could
not be verified were removed rather than left standing. If you find one that has drifted,
fix the code or fix this file — do not leave it.

General working standards live in the global `~/.claude/CLAUDE.md` and are not repeated here.

## What Kuralle is

A **TypeScript framework for building conversational AI agents** with structured flows,
routing, and durable tool execution. Monorepo on Bun workspaces, built on the Vercel AI SDK
(OpenAI, Anthropic, Google, xAI).

- **Agents** — one tagless primitive: `defineAgent({ id, model, instructions, tools?,
  globalTools?, flows?, routes?, routing?, agents?, handoffs?, policy? })`. Behaviour is
  derived from which fields you populate: `flows[]` → flow agent, `routes` + `routing` →
  triage, `agents[]` → composition.
- **Flows** — node graphs via `defineFlow` + `reply` / `collect` / `action` / `decide`. Each
  node returns its next transition.
- **Runtime** — `createRuntime(...)` → `Runtime`; `runtime.run({ input, sessionId })` →
  `TurnHandle` (`.events` AsyncIterable, awaitable result,
  `toResponseStream('sse' | 'ndjson')`). Orchestrates sessions, history, handoffs, streaming,
  hooks. Flow state (`activeFlow` / `activeNode`) lives on the run state.
- **Tools** — `defineTool({ name, description, input: <zod>, execute })` creates a durable
  effect tool. `buildToolSet(...)` exposes it to the model while the durable executor runs it
  against an effect log → **exactly-once-modulo-idempotency**: a finished step replays without
  re-executing; a crash between execute and finalize re-runs the effect, so external side
  effects must honour the idempotency key.
- **Policy** — `Policy.decide(req)` returns `allow` / `ask` / `deny` per tool call. Set on
  `HarnessConfig` (runtime default) or `AgentConfig` (per-agent, which is what a delegated
  read-only worker needs). `needsApproval: true` is sugar for a policy returning `ask`.
  See `/guides/policy`.
- **Sessions** — `SessionStore` interface; backends: Memory (default), Redis, Postgres.
- **Runtimes** — Node/Bun via `@kuralle-agents/hono-server`; Cloudflare Workers/Durable
  Objects via `@kuralle-agents/cf-agent`.
- **Voice** — out of scope; it lives in a separate repo. Inbound voice notes remain supported
  as multimodal audio input.

## Design rules

- **SOP lives in flows, not prompts.** Pasting >20 lines of procedure into a system prompt
  means it belongs in a flow.
- **Enforce at the tool boundary, not in the prompt.** Repeatedly demonstrated under
  adversarial testing: every safety property enforced by a tool boundary or a typed
  transition held; every property that depended on the model recalling or finding something
  failed. If a rule matters, make it structural.
- **Pure dispatchers route silently by derived shape** — there is no `routing.mode`, and
  dispatch never leaks to the user.
- **Grounding is explicit if promised** — CAG tools + retrieval for always-grounded agents.
- **Tools return data.** Control results (`toolDeniedResult`, `toolErrorResult`) are the one
  exception: they carry a `message` the model reads to decide what to say next. Ordinary
  tools must not return conversational text; flow control comes from node transitions.

## Commands

```bash
bun run build            # build all packages (topological)
bun run test             # all unit tests
bun run typecheck        # examples + templates typecheck
bun run typecheck:all    # every framework tsconfig + lint (the full gate)
bun run clean            # clean all builds

cd packages/<pkg> && npm run build   # build one package
```

Publish:
```bash
pnpm changeset           # describe the change
pnpm release             # version + build + publish (all packages version together)
```

E2E tests: see `packages/e2e-tests/README.md`.

## Adding a feature

1. Start in `@kuralle-agents/core` for primitives or runtime changes; types under
   `packages/core/src/types/`.
2. Update the runtime / flow execution paths; keep streaming semantics stable
   (`text-delta`, tool events, `done`).
3. Add a runnable example under `packages/core/examples/` — and **run it live**, not just
   typecheck it.
4. Update the docs (`apps/docs/`, package READMEs, `docs/skills/`) in the same change.

## Gotchas — learned the hard way, all still live

- **Stale dist.** Workspace packages import each other's `dist/`, not `src/`. After editing a
  package's `src/`, rebuild before running anything that depends on it. The most common
  "my fix didn't take" false negative.
- **Version and publish *together*, never piecemeal.** `pnpm` rewrites `workspace:*` to the
  *exact* dependency version at publish time, so publishing `core@x` alone leaves dependents
  pinning the old exact version → consumers install two copies of `core` → `tsc` errors about
  "separate declarations of a private property". All publishable packages sit in one `fixed`
  group for this reason.
- **`changeset:version` runs `pnpm install`,** which creates a second copy of `agents`
  alongside Bun's and breaks `typecheck:all` with a spurious type mismatch. Run `bun install`
  before gating. False red on three consecutive releases.
- **Run examples — typecheck is not enough.** A published feature can be unreachable:
  `RecoverableToolError` shipped in 0.16.0 exported from nowhere, and only a live run caught it.
- **Prove a test discriminates.** Disable the fix, watch the test fail, restore it. Two tests
  written this week passed with their fix disabled; one regression shipped because the suite
  was not re-run before claiming done.
- **`zsh` does not word-split unquoted parameters.** `CMD=$FLAGS` passes one argv element, so
  a command invoked with `$FLAGS` silently runs with none of them. Use explicit args.
- **Never bundle a real `.env`** in a published artifact — only `.env.example`.
- **No source maps** (`.map`) in published tarballs.
- **`npm` / `wrangler` `config.load()` failure** — these CLIs error when run from *inside* a
  monorepo package dir. Run them from a neutral cwd.
- **Model preference in examples** — `resolveTemplateModel` prefers **xAI → Google → OpenAI**
  by which provider key is present. To force OpenAI, clear `XAI_API_KEY` and the Google keys.
- **Playground apps (`apps/playground/*`) are excluded from `typecheck:all`** and rot silently.

## Key docs

- `README.md` — onboarding · `apps/docs/` — the documentation site (Astro Starlight)
- `docs/skills/kuralle-usage/` — usage skill for coding agents
- `docs/skills/kuralle-framework-development/` — framework-dev skill
- `docs/research/` — primary sources behind current RFCs
- `CONTRIBUTING.md` — monorepo dev/build/publish workflow

@.plandesk/skill.md

<!-- plandesk-factory:start -->
## Plan Desk Factory — default operating mode

This repository runs on the Factory workflow. On any work request:
1. **Follow the factory cycle** — the always-on [factory.md](.agents/factory/factory.md) contract governs each work item: pull → read → red gate → delegate → prove → observe → gate → ship. Bracket the session with `start_agent_run` / `complete_agent_run`; call `record_agent_progress` every cycle.
2. **Delegate implementation by default — when a worker is available.** The supervisor orchestrates; IC workers execute. Probe the dispatchers in [.agents/factory/workers/](.agents/factory/workers/) per [protocol.md](.agents/factory/protocol.md) and hand each work item to a probed worker. **If no worker is installed on this machine, do the work yourself under the same contract** — never skip the cycle just because you are the one typing, and never assume a delegation skill or worker CLI exists that this repo did not ship. Write inline without dispatch only for trivial edits, integration/conflict resolution, and review fixes under ~5 lines.
3. **Execute without pausing** — decompose the goal into verifiable moves on a harness task list (`TaskCreate` / `TaskList` / `TaskUpdate`), drive them to zero, and ship finished work without pausing for permission. The IC spine is [execution.md](.agents/factory/execution.md).
4. **Prove before done** — re-run the claimed checks per [protocol.md](.agents/factory/protocol.md); exit codes are authoritative.

New to this repo? Run `plandesk onboard` for the full Plan Desk + Factory model and the operating loop.

@.agents/factory/factory.md
<!-- plandesk-factory:end -->
