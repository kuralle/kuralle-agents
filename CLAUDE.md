# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Engineering Philosophy

We are building a framework developers will depend on. Every decision reflects that responsibility.

**No shortcuts. Always do the right thing.**

- Never take pragmatic workarounds. If something needs publishing before a dependent deploy, publish it first.
- Docs stay in sync with code. Never ship a feature without documentation; never leave docs pointing at removed code.
- Best engineering principles and design patterns. No hacks, no "we'll fix it later."
- No source maps (`.map`) in published tarballs.
- Publish with `pnpm publish -r` (replaces `workspace:*` with real versions). Dev uses Bun; publish uses pnpm.
- Quality over speed, always.

**Non-negotiable working rules**
- Never reason shallowly. Never choose a quick "fix" over an elegant solve.
- Never leave a task incomplete. Never skip code review.

## How to work here

### 1. Think before coding
State assumptions explicitly; if uncertain, ask. If multiple interpretations exist, surface them — don't pick silently. If a simpler approach exists, say so. If something's unclear, stop and name it.

### 2. Simplicity first
Minimum code that solves the problem. No speculative features, no abstractions for single-use code, no error handling for impossible cases. If 200 lines could be 50, rewrite it.

### 3. Surgical changes
Touch only what the task requires. Don't refactor what isn't broken; match existing style. Remove orphans *your* change created; leave pre-existing dead code (mention it). Every changed line traces to the request.

### 4. Goal-driven execution
Turn tasks into verifiable goals ("add validation" → "write tests for invalid inputs, then make them pass"). Prove it: a green gate, an observed behavior, a passing test — not "should work."

## Architecture

Kuralle is a **TypeScript framework for building conversational AI agents** — text and voice — with structured flows, routing, and durable tool execution. Monorepo on Bun workspaces; built on the Vercel AI SDK (OpenAI, Anthropic, Google, xAI).

- **Agents** — one tagless primitive: `defineAgent({ id, model, instructions, tools?, globalTools?, flows?, routes?, routing?, agents?, handoffs? })`. Behavior is derived from the fields you populate: `flows[]` → flow agent, `routes` + `routing` → triage, `agents[]` → composition.
- **Flows** — node graphs via `defineFlow` + `reply`/`collect`/`action`/`decide`; each node returns its next transition. Hybrid mode answers off-flow questions, then resumes.
- **Runtime** — `createRuntime(...)` → `Runtime`; `runtime.run({ input, sessionId })` → `TurnHandle` (`.events` AsyncIterable, awaitable result, `toResponseStream('sse')`). Orchestrates sessions, history, handoffs, streaming, hooks. Flow state lives in the session.
- **Tools** — `defineTool({ name, description, input: <zod>, execute })` creates a durable effect tool; `buildToolSet(...)` exposes it to the model (model-visible schema) while `tools` runs the durable executor (effect log → exactly-once on retry).
- **Sessions** — `SessionStore` interface; backends: Memory (default), Redis, Postgres.
- **Voice** — provider-native realtime in `@kuralle-agents/realtime-audio` (`VoiceEngine`) drives Gemini/OpenAI/xAI `RealtimeModel` audio while Kuralle keeps tool/flow/handoff authority. LiveKit voice is cascaded-only (`KuralleRuntimeLLMAdapter`: STT→LLM→TTS).
- **Runtimes** — Node/Bun via `@kuralle-agents/hono-server`; Cloudflare Workers/Durable Objects via `@kuralle-agents/cf-agent`.

### Non-negotiable design rules
- **SOP lives in flows, not prompts** — pasting >20 lines of procedure into a system prompt means it belongs in a flow.
- **Triage must be structured when it routes** — `routing: { mode: 'structured' }` so dispatch never leaks to the user.
- **Tools return data only** — never conversational text; flow control comes from node transitions, not tool output.
- **Grounding is explicit if promised** — CAG tools + retrieval for always-grounded agents.

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

**Stale dist gotcha:** workspace packages import from each other's `dist/` (compiled), not `src/`. After editing a package's `src/`, rebuild it before running anything that depends on it — stale dist is a common "my fix didn't take" false negative.

**Voice / E2E tests** (offline fake-client + live API modes): see `packages/kuralle-e2e-tests/README.md` and the `@kuralle-agents/realtime-audio` test suite.

## Adding a feature
1. Start in `@kuralle-agents/core` for primitives or runtime changes; update types under `packages/kuralle-core/src/types/`.
2. Update the runtime / flow execution paths; keep streaming semantics stable (`text-delta`, tool events, `done`).
3. Add a runnable example under `packages/kuralle-core/examples/` — and **run it** (live smoke), not just typecheck it (see Gotchas).
4. Update the docs (`apps/docs/`, package READMEs, `docs/skills/`) — in the same change.

## Gotchas & disciplines (learned the hard way)

- **Version + publish *together*, never piecemeal.** `pnpm` rewrites `workspace:*` to the *exact* dependency version at publish time. So publishing `core@x` alone leaves every dependent (e.g. `hono-server`) pinning the *old exact* `core` → consumers install two copies of `core` → `tsc` errors ("separate declarations of a private property"). Bump and `pnpm publish -r` the whole graph — or at minimum every package a template/consumer installs — in one release.
- **Run examples and templates — typecheck is not enough.** A flow/agent example that compiles can still throw at runtime (both shipped `*-direct-functions` flow examples crashed on the first tool call: schema registered, executor not). Execute a live smoke before shipping; gate templates with a build-smoke (`verify-templates.sh`). "Untested example = broken example."
- **Ship a tested lockfile with each template** so `npm install` is deterministic — a transitive major bump (e.g. `next-themes`) can break a previously-green scaffold (ERESOLVE, or a dropped subpath like `next-themes/dist/types`).
- **Never bundle a real `.env` in a published artifact** — only `.env.example`. A bundled `.env.local` once leaked a key. The starter sync excludes every `.env*` except `.env.example`.
- **`npm`/`wrangler` `config.load()` failure** — these CLIs error ("call config.load() before reading values") when run from *inside* a monorepo package dir. Run them from a neutral cwd (repo root or `/tmp`).
- **Forcing a model in examples/templates** — `resolveTemplateModel`/`requireLiveModel` prefer **xAI → Google → OpenAI** by which provider key is present. To force OpenAI, clear `XAI_API_KEY` + the Google keys; otherwise you may hit a stale Grok model (404) or a Google quota (429) that *looks* like an OpenAI failure but isn't.
- **Playground apps (`apps/playground/*`) are excluded from `typecheck:all`** and rot silently (a trailing-comma `package.json` went uncaught). If a playground demo is referenced by docs/guides, either add it to CI or fold it into the relevant package's `examples/`.

## Key docs
- `README.md` — onboarding. `apps/docs/` — the documentation site (Astro Starlight).
- `docs/skills/kuralle-usage/` — usage skill for coding agents. `docs/skills/kuralle-framework-development/` — framework-dev skill.
- `CONTRIBUTING.md` — monorepo dev/build/publish workflow.
