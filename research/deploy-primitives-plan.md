# Kuralle Deploy Primitives — Plan

## 1. Executive summary

Kuralle already has **two fully working deploy targets** — a Hono server (`createKuralleChatRouter`, `kuralle-hono-server/src/index.ts:338`) for any Node/Bun host, and a Cloudflare Durable Object base class (`KuralleAgent`, `kuralle-cf-agent/src/KuralleAgent.ts:56`). The gap is not *capability*; it is *glue*: every app hand-wires its own entry file, `wrangler.jsonc`, secrets, and `flyctl/wrangler` invocation. We are NOT building a platform-abstraction runtime, a multi-sandbox SDK, or a `kuralle.deploy.json` schema language.

**The one core idea:** a thin `kuralle deploy` CLI that (a) **scaffolds the target's native config + entry file** once (`wrangler.jsonc` for CF, `Dockerfile`/start script for Node), and (b) **shells out to the platform's own CLI** (`wrangler deploy`, `flyctl deploy`). We adopt Flue's *one-small-interface-per-target* seam (`BuildPlugin`), reject its sandbox/connector machinery as irrelevant to us, and steal Hare's concrete CF wiring (bindings, DO migration tags, secret filtering) verbatim because it is the real, deployed reference.

## 2. Primitives from Flue — multi-platform/adapter abstraction

Flue's deploy story is a **two-tier pipeline**: a `BuildPlugin` per target (build/entry strategy) and a `SessionEnv` sandbox contract (where code runs). Only the first tier is relevant to Kuralle.

### STEAL

- **`BuildPlugin` as the seam** (`packages/cli/src/lib/types.ts:61-91`). The irreducible per-target contract is tiny: `name`, `generateEntryPoint()`, `bundle` strategy, `additionalOutputs?()` (extra files like `wrangler.jsonc`, `Dockerfile`). Adding a target is one plugin, no core CLI change. This is exactly the shape Kuralle needs: a `DeployTarget` interface implemented by `cloudflare` and `node`.
- **Separate discovery from generation** (`packages/cli/src/lib/build.ts:54-85`). Agents/workflows are discovered *once*; each plugin only generates the **glue entry point** (`server.mjs` vs `_entry.ts`). For Kuralle the analogue: the user's `runtime` factory is discovered once; each target only emits its wrapper (Hono `serve()` boot vs DO class export + `wrangler.jsonc`).
- **`additionalOutputs()` for native config** (`build-plugin-cloudflare.ts` merges user `wrangler.jsonc`). This is the right place to emit `wrangler.jsonc`/`Dockerfile` rather than inventing our own manifest.

### SKIP (over-abstraction for us)

- **`SessionEnv` / `SandboxApi` / `SandboxFactory`** (`packages/runtime/src/types.ts`). This is Flue's *agent-runs-shell-in-a-remote-sandbox* model (Daytona/E2B/Modal — `connectors/sandbox--daytona.md:142-150`). Kuralle agents do not exec shells in third-party sandboxes; our "where it runs" is the deploy host itself. Adopting this would be pure speculative abstraction.
- **Markdown-first connectors** (`connectors/README.md`, "agent-as-installer" doc fetched to stdout). Clever for Flue's sandbox-provider sprawl, but Kuralle has exactly **two** first-party targets we control. Ship them as code, not docs-as-installer.
- **`flue run`/`flue connect` IPC subprocess model** (`flue.ts:900-1033`). That is a local-execution runner, orthogonal to deploy.
- **A `defineConfig({ target })` config file** (`config.ts:21-48`). For two targets, a `--target` flag + auto-detection beats a config file. Defer until a third target appears.

## 3. Primitives from Hare — CF-native deploy

Hare is a **real, deployed** CF Workers app. Its value is the *concrete wiring*, not abstractions (it has none — it just calls `wrangler deploy`, `apps/web/package.json:14`). Steal the facts.

### STEAL

- **Two-phase deploy = build then upload** (`apps/web/package.json:14`: `"deploy": "bun run build && wrangler deploy"`). This is the entire CF deploy. Kuralle's `cloudflare` target does the same: `vite build` (or `tsc`) → `wrangler deploy`. No orchestration layer needed.
- **Bindings live in `wrangler.jsonc`, declared once** (`apps/web/wrangler.jsonc:1-144`): Workers `main`, DO bindings + **migration tags** (`wrangler.jsonc:94-99` — `new_sqlite_classes` per DO class, tagged `v1`), observability sampling. Kuralle's CF example already mirrors this exactly (verified: `cf-voice-realtime-openai/wrangler.jsonc` declares the DO binding + `new_sqlite_classes` migration `v1`). Our scaffolder emits this shape.
- **DO SQLite migration discipline** (`wrangler.jsonc:94-99`). New DO class → new `new_sqlite_classes` migration tag. Kuralle's `OrchestrationStore` already uses `durableAgentSurface().sql`, so the scaffolder must emit the matching migration entry or the deploy fails. This is the one CF gotcha worth encoding as a generation rule.
- **Secret filtering: one `.env` → two outputs** (`scripts/env.ts:82-96` — strip `VITE_*` for the Workers `.dev.vars`; `wrangler secret put` for runtime secrets, `wrangler.jsonc:vars` for public config). Kuralle's secrets are simpler (`OPENAI_API_KEY`, `PROVIDER`, etc.), but the *pattern* — build-time creds vs runtime secrets vs public vars — is exactly what `kuralle deploy` should validate and print as a checklist.
- **Conditional remote driver** (`drizzle.config.ts:14-22` — only enable `d1-http` when all CF creds present). Analogue: `kuralle deploy --target cloudflare` should pre-flight that `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` exist before invoking `wrangler`, and *warn* rather than fail when only doing a dry-run.

### SKIP / NOT NOW

- D1/R2/KV/Vectorize/Workers-AI/rate-limiter/browser bindings (`wrangler.jsonc` table). Hare is a full product; Kuralle's CF agent needs **only** the DO binding + SQLite migration + optional ASSETS. Do not scaffold bindings the agent doesn't use.
- Drizzle migration CI (`db-migrate.yml`), Elysia dual-routing (`server.ts:15-31`), Better-Auth. Product concerns, not framework-deploy concerns.

## 4. Kuralle current state — Node path vs CF path

### Node/Bun path (EXISTS, working)
- `createKuralleChatRouter({ runtime })` → Hono instance (`kuralle-hono-server/src/index.ts:338`; also `createKuralleRouter` at `:879`). Routes: `/api/chat`, `/api/chat/stream|sse|resume`, `/api/session/*`, WS `/ws/:sessionId`.
- Runtime factory: `createRuntime(config: HarnessConfig): Runtime` (`kuralle-core/src/runtime/Runtime.ts:356`; class at `:69`). `runtime.run()` yields `HarnessStreamPart` async generator — the single platform-neutral seam.
- Exemplars: `apps/playground/acme-support-agent/src/server.ts` (createRuntime → router → `serve` on PORT 3335), `rag-demo/server.ts` (PORT 3334). Each hand-rolls boot + WS wiring.
- Fly configs exist per-app (`fly-sip-voice-agent/fly.toml`, `gemini-voice-agent/fly.toml`); root `Dockerfile` is hardcoded to hospital-demo.

### Cloudflare path (EXISTS, working)
- `abstract class KuralleAgent<Env, State>` extends CF `AIChatAgent` (`kuralle-cf-agent/src/KuralleAgent.ts:56`). Subclass implements `getAgents()` / `getDefaultAgentId()` / `getRuntimeConfig()?`. CF owns persistence/WS/resumability; Kuralle owns orchestration via `BridgeSessionStore` + `OrchestrationStore` (DO SQLite).
- Stream adapter `createSSEResponse()` (`StreamAdapter.ts`) maps `HarnessStreamPart` → AI SDK.
- Example `cf-voice-realtime-openai/`: `wrangler.jsonc` (DO binding = class name, `new_sqlite_classes` migration `v1`, ASSETS spa, observability), entry `src/server.ts` via `routeAgentRequest()`. Secrets via `wrangler secret put`, provider via `PROVIDER` var.

### What's MISSING (the actual gap)
1. No shared deploy entry generator — every app hand-wires the boot file.
2. No `kuralle deploy` command — `create-kuralle-agents` (`src/index.ts`) only scaffolds via `@bluwy/giget-core`, never deploys.
3. No target auto-detection (presence of `wrangler.jsonc`/DO export vs Hono server).
4. No secret pre-flight / checklist (CF needs `CLOUDFLARE_API_TOKEN`; both need `OPENAI_API_KEY` etc.).
5. No consistent `build`/`start`/`deploy` scripts across apps.

## 5. THE PROPOSED PRIMITIVE SET (minimal)

One interface, two implementations, one CLI. Nothing else.

### 5.1 The platform-adapter interface

Borrowed in spirit from Flue's `BuildPlugin` (`types.ts:61-91`), trimmed to what two first-party targets need:

```ts
// packages/kuralle-deploy/src/types.ts
export interface DeployTarget {
  /** 'cloudflare' | 'node' */
  readonly name: TargetName;

  /** Heuristic: is THIS project already shaped for this target? */
  detect(project: ProjectInfo): boolean;

  /**
   * Idempotently write the target's NATIVE config + entry glue into the
   * project (wrangler.jsonc + DO entry for CF; Dockerfile + start script
   * for Node). Returns the files written. Re-runnable; never clobbers
   * user edits without --force.
   */
  scaffold(project: ProjectInfo, opts: ScaffoldOpts): Promise<WrittenFile[]>;

  /** Required env: build-time creds, runtime secrets, public vars. */
  requiredEnv(): EnvRequirement[];

  /**
   * Build artifacts, then invoke the platform's OWN CLI.
   * CF:   vite/tsc build → `wrangler deploy`
   * Node: `docker build` (or tar) → emit run instructions / `flyctl deploy`
   * Honors opts.dryRun (print the command, don't run it).
   */
  deploy(project: ProjectInfo, opts: DeployOpts): Promise<DeployResult>;
}

export interface ProjectInfo {
  root: string;            // absolute
  pkgJson: PackageJson;
  /** Path to the module that default-exports the runtime/agent. */
  entry: string;
}

export interface EnvRequirement {
  name: string;                 // 'OPENAI_API_KEY'
  kind: 'build-cred' | 'runtime-secret' | 'public-var';
  required: boolean;
}

export interface DeployResult { url?: string; command: string; ranCli: boolean; }
```

That is the whole abstraction. No sandbox contract, no manifest DSL, no platform-injection into `HarnessConfig` (the brief's "seam #1" proposal — **explicitly rejected**, see below).

### 5.2 Deploy lifecycle (ordered)

**Shared (target-agnostic), in order:**
1. **Detect project** — read `package.json`, locate the runtime entry module.
2. **Resolve target** — `--target` flag wins; else `target.detect()` over registered targets; else error with the two choices.
3. **Pre-flight env** — diff `target.requiredEnv()` against `process.env` / `.dev.vars`; print a checklist; fail on missing **required build-creds**, warn on missing runtime-secrets (they may be set via `wrangler secret put` / host dashboard).
4. **Scaffold (if needed)** — if native config absent, `target.scaffold()`; print written files.

**Per-target (inside `target.deploy()`):**
5. **Build** — CF: `vite build` (or `tsc` for asset-less agents) → Worker bundle + `dist/client`. Node: `docker build` or a tarball + `start` script.
6. **Upload / hand off** — CF: `wrangler deploy`. Node: `flyctl deploy` if `fly.toml` present, else print docker run / host instructions. `--dry-run` prints the exact command and stops.
7. **Report** — URL (CF gives one; Node depends on host), the command run, exit status.

### 5.3 CLI surface

```
kuralle deploy [--target cloudflare|node] [--dry-run] [--force]
kuralle deploy --target cloudflare            # scaffold wrangler.jsonc if missing, then wrangler deploy
kuralle deploy --dry-run                       # detect + pre-flight + print command, run nothing
```

- **Target detection** (when `--target` omitted): CF if a `wrangler.jsonc` exists **or** the entry exports a `KuralleAgent` subclass; Node if a Hono server / `createKuralleChatRouter` usage is present. Ambiguous → error listing both. (Mirrors Hare's "config presence drives behavior", `drizzle.config.ts:14-22`.)
- **Flags kept deliberately tiny:** `--target`, `--dry-run`, `--force`. No `--target fly.io|railway|k8s` sub-targets, no `--staging/--production`, no canary. Node deploy just builds the artifact + emits the host's command; the *host* (Fly/Railway/Docker) is the user's choice, not our matrix.

### 5.4 What we are deliberately NOT abstracting

- **No `platform` field on `HarnessConfig`** and no `NodeRuntimeAdapter`/`CFRuntimeAdapter` wrappers (rejecting the surface-map's seam #1/#2). The runtime is *already* platform-neutral — it yields `HarnessStreamPart`. Wrapping it again is abstraction for its own sake.
- **No `kuralle.deploy.json` manifest** (rejecting seam #6). The native config (`wrangler.jsonc`, `Dockerfile`, `fly.toml`) IS the manifest. Inventing a second one means keeping two in sync forever.
- **No generic build pipeline** (`buildPackageForPlatform`, seam #4). CF uses `wrangler`'s own build; Node uses Docker. We don't own a bundler.
- **No bindings beyond DO + ASSETS** for CF (no D1/R2/KV scaffolding). Kuralle's agent needs only the DO + its SQLite migration.
- **No CI/CD templates in v1.** Optional follow-up, not first iteration.

## 6. First-iteration scope (smallest shippable)

**Two targets: `cloudflare` (Workers + DO) and `node` (Docker-buildable Hono server).** These are the two that already work end-to-end; deploy just removes the hand-wiring.

### New package
- `packages/kuralle-deploy/` — the CLI + the two `DeployTarget` impls.
  - `src/types.ts` — `DeployTarget`, `ProjectInfo`, `EnvRequirement` (§5.1).
  - `src/cli.ts` — arg parse (`--target/--dry-run/--force`), the shared lifecycle (§5.2 steps 1–4), dispatch to target.
  - `src/targets/cloudflare.ts` — `detect`/`scaffold`/`requiredEnv`/`deploy`. Scaffold emits `wrangler.jsonc` (DO binding named after the agent class, `new_sqlite_classes` migration tag, optional ASSETS) + a `src/server.ts` entry using `routeAgentRequest()`, modeled on `packages/kuralle-cf-agent/examples/cf-voice-realtime-openai/`. Deploy = build → `wrangler deploy`.
  - `src/targets/node.ts` — scaffold emits a `Dockerfile` (Bun base, per root `Dockerfile`) + `start` script that boots `createKuralleChatRouter` on `PORT`, modeled on `apps/playground/acme-support-agent/src/server.ts`. Deploy = `docker build`; if `fly.toml` present, offer `flyctl deploy`; else print run instructions.
  - `bin` entry `kuralle` → `dist/cli.js`.

### Touch (light)
- `packages/create-kuralle-agents/src/index.ts` — after scaffold, add a `deploy` script to the generated `package.json` and print "next: `kuralle deploy`". (No coupling; just wiring.)
- `packages/kuralle-hono-server` — export a tiny `serveKuralle({ runtime, port })` boot helper so the Node scaffold's `start` script is one line instead of re-implementing `@hono/node-server` + WS each time. (Extract the existing `acme-support-agent/src/server.ts:24-41` boot, no new behavior.)
- One reference per target updated to use the new flow as the live smoke (per CLAUDE.md "run examples, typecheck is not enough"): `acme-support-agent` (node) and `cf-voice-realtime-openai` (cf).

### Verification gate (per CLAUDE.md)
- `kuralle deploy --target cloudflare --dry-run` in the CF example prints the correct `wrangler deploy` and scaffolds a `wrangler.jsonc` byte-comparable to the hand-written one.
- `kuralle deploy --target node --dry-run` in acme produces a `Dockerfile` that `docker build`s green and boots, serving `/api/chat`.
- A live CF `wrangler deploy` and a live Node container boot, each observed answering one turn end-to-end (not just typecheck).

## 7. Open questions / risks

1. **CF DO binding naming.** The example uses the **agent class name as the DO binding name** (verified in `cf-voice-realtime-openai/wrangler.jsonc`). The scaffolder must read the user's `KuralleAgent` subclass name to emit a correct binding + matching `new_sqlite_classes` tag. Risk: multiple agent classes, or a renamed class on redeploy needing a *new* migration tag (CF rule). Need a deterministic rule: tag = `v{N}` incremented when class set changes; detect drift and warn.
2. **Node "deploy" is host-shaped, not a single command.** Unlike CF (`wrangler deploy` is universal), Node deploy depends on host (Fly/Railway/Docker/K8s). Scope decision: v1 produces a buildable artifact + emits the host command (Fly if `fly.toml`), and does **not** try to own every host. Confirm this is acceptable vs. expecting `kuralle deploy` to fully deploy to a named PaaS.
3. **Stale-dist gotcha (CLAUDE.md).** `kuralle-deploy` will import from `kuralle-hono-server`/`kuralle-cf-agent` `dist/`. The new `serveKuralle` helper must be built+published in the same release, or the scaffold imports break (the documented "version + publish together" rule).
4. **Secrets vs build-creds boundary.** CF needs `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` at deploy time but `OPENAI_API_KEY` at *runtime* (`wrangler secret put`). The pre-flight must classify correctly (Hare's `scripts/env.ts:82-96` filter is the reference) or it will false-fail on a runtime secret the user sets in the dashboard.
5. **Does `kuralle deploy` belong in `create-kuralle-agents` or its own package?** Recommend its own `kuralle-deploy` (single `kuralle` bin) so it works on existing projects, not only freshly-scaffolded ones. Confirm the bin name `kuralle` doesn't collide with a future broader CLI.
