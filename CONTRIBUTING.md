# Contributing to Kuralle

This document covers monorepo setup, build/test workflows, adding features, and publishing.

---

## Setup

```bash
bun install   # monorepo root
```

Set API keys in `.env`:

```bash
OPENAI_API_KEY=sk-...
```

---

## Build

```bash
# All packages
bun run build

# Packages only
bun run build:packages

# A single package
cd packages/core && npm run build
```

**Rebuild before E2E testing.** Workspace packages import from `dist/` (compiled output), not source. After editing a package's `src/`, rebuild it before running E2E tests or packages that depend on it. Stale dist is a common source of false negatives.

---

## Test

```bash
bun run test
```

### Voice pipeline tests

Two modes: offline (no API keys, <1s) and live (real Gemini, 30-60s per turn).

**Offline — FakeRealtimeAudioClient (CI-safe, deterministic):**
```bash
bun test packages/e2e-tests/tests/fake-client.test.ts
```

**Live API — real Gemini audio (needs `GOOGLE_GENERATIVE_AI_API_KEY`):**
```bash
npx tsx packages/e2e-tests/tests/livekit-model-ws-bridge.ts    # single-turn
npx tsx packages/e2e-tests/tests/bridge-adapter-debug.ts        # multi-turn
npx tsx packages/e2e-tests/tests/head-to-head-benchmark.ts      # 3-path benchmark
```

**AgentSession + Kuralle (needs `DEEPGRAM_API_KEY` + `GOOGLE_GENERATIVE_AI_API_KEY`):**
```bash
npx tsx packages/e2e-tests/tests/agentsession-kuralle-direct-e2e.ts
npx tsx packages/e2e-tests/tests/agentsession-kuralle-e2e.ts
```

See `packages/e2e-tests/README.md` for the full test catalog.

---

## Run examples

```bash
# Core examples
cd packages/core
npx tsx examples/agents/form-filler.ts
npx tsx examples/agents/basic-chat.ts
npx tsx examples/flows/patient-intake.ts

```

---

## Repository layout

| Path | Purpose |
|------|---------|
| `packages/` | Published packages (`@kuralle-agents/*`) |
| `apps/` | Apps and playgrounds |
| `apps/playground/` | Local test apps |
| `docs/skills/` | IDE/coding-agent skill files |

---

## Adding a feature

1. Start in `@kuralle-agents/core` for primitives or runtime changes.
2. Update types in `packages/core/src/types/`.
3. Update `Runtime`, `FlowManager`, or drivers as needed.
4. Add an example in `packages/core/examples/`.
5. If config-driven, update `@kuralle-agents/config` loader (`runtimeLoader.ts`).
6. Update `docs/skills/` and any relevant guides.
7. Rebuild the package and run examples to verify.

---

## Builder CLI

```bash
cd packages/builder
npm run build

# Build a pack from an .kuralle folder
node dist/cli.js build-pack <input-dir> [output-dir] --runtime hono|cf|docker

# Build starter packs
node dist/cli.js build-pack starters/basic ./my-agent
node dist/cli.js build-pack starters/support ./my-support --runtime cf
```

Full guide: `packages/builder/guide/README.md`

---

## Config CLI

```bash
kuralle validate --config ./kuralle.jsonc
kuralle debug
kuralle list agents|flows|tools|skills
kuralle copy <starter>
```

Full guide: `packages/config/guide/README.md`

---

## Publish

All 24 packages version together (`"fixed"` in `.changeset/config.json`). Dev uses Bun; publish uses pnpm (handles `workspace:*` → exact version replacement).

```bash
# Describe the change and pick bump type
pnpm changeset

# Version + build + publish all packages
pnpm release

# Or step by step:
pnpm changeset:version    # bump versions + changelogs
pnpm changeset:publish    # build + publish via pnpm
```

Use `pnpm publish -r` (not `changeset publish`) to correctly replace `workspace:*` with actual versions. Publish packages before deploying apps that depend on them — never deploy against unpublished local workspace packages.

---

## Non-negotiable rules

1. **SOP lives in flows**, not system prompts (>20 lines → move to a flow).
2. **Structured routing** when `routes` dispatch — prevents handoff leaks.
3. **Tools return data only** — transitions come from node handlers.
4. **Grounding must be explicit** — use CAG tools + auto-retrieve when you promise grounded responses.
5. **Source maps must not ship** in published packages — no `.map` files in npm tarballs.
6. **Docs must be in sync with code** — never ship a feature without updating documentation.

Full rules: `docs/skills/kuralle-usage/rules/`
