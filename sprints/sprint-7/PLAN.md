# Sprint 7 — Plan (FINAL)

**Sprint name:** Integration, proof & release
**Sprint goal (one sentence):** The multi-platform example demonstrates one bot answering on WhatsApp + Web + Instagram, window-safe, with the full §9 test matrix green and a publish-together dry-run clean.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

> **This is the final sprint.** After closeout, the WBS is exhausted → the program stops (driver § When to stop). Summarize all shipped sprints.

---

## 0. Decisions made before briefing (read first)

- **F1 `engagement()` composes the chain; the router appends the terminal `windowGuard`.** `createMessagingRouter.buildOutboundChain(extra) = [...extra, windowGuard]` (S1-03), so `bridge.outbound` must be the **pre-guard** middleware in order: `[consentGate(consent)?, ownershipGate(ownership)?, closedWindowRecovery(policies), interactiveRenderer(policies)]` (gates only when the store is provided). The router appends `windowGuard` terminal. Do NOT put `windowGuard` in `bridge.outbound`.
- **`bridge` shape** = `Pick<MessagingRouterConfig, 'outbound'|'inputResolver'|'windowStore'|'ownership'|'consent'|'onStatus'>` (all fields already exist on `MessagingRouterConfig`). `bridge.inputResolver = [policyInboundResolver(policies)]` (a plugin dispatching `policyFor(m.platform).resolveInbound(m)`, with a text catch-all). `bridge.windowStore` = a shared `InMemoryWindowStore` (the same instance the policies read — pass it into the policies and the bridge). `bridge.ownership`/`bridge.consent` passed through for the inbound gate + STOP.
- **`.broadcasts` wiring (the one underspecified seam in §4.5).** `createBroadcasts` (S5) needs a pipeline + sink. The policies don't expose their clients, so `engagement()` cannot build a broadcast pipeline from `policies` alone. **Resolution:** `engagement(opts)` accepts an optional `broadcasts?: { ledger?; pipelineFor?(platform): OutboundPipeline }` OR returns `broadcasts` built from `opts.consent` + `opts.ledger ?? createInMemoryBroadcastLedger()` with the pipeline supplied by the caller at construction. Keep F1 honest: deliver `bridge` rigorously (the REQ-22 core), and wire `broadcasts` as a thin `createBroadcasts(...)` constructed from the provided `consent`+`ledger`+a pipeline the caller passes (the F2 example constructs the WhatsApp broadcast pipeline explicitly). Document the chosen `engagement()` option shape. If §4.5's `.broadcasts` can't be wired without the clients, expose `engagement({..., broadcastPipeline?})` and note it — not a divergence, a concretization.
- **F2 extends the existing example** (`packages/kuralle-messaging-meta/examples/multi-platform/server.ts`) to wire `engagement({policies:[whatsappPolicy(...), webPolicy(), instagramPolicy(...)]})` and demonstrate the SAME agent/flow set on all three channels, driven **offline by the fake-client** (no live Meta/AI). The example must build (`typecheck:all` sweeps it) and the `same_bot_across_channels` E2E must pass.
- **F3 publish-together dry-run (CLAUDE.md).** `pnpm publish -r --dry-run` from a **neutral cwd** (repo root or /tmp — the monorepo `config.load()` gotcha). Version+publish the whole changed `@kuralle-agents/*` graph together (core/messaging/messaging-meta/engagement) — the dry-run must show **no split-graph pin** (a dependent pinning an old exact `core` → two copies). No `.map` files in the would-be tarballs (`scripts/check-no-source-maps.sh`). **Engagement is `0.0.0`** — F3 may need to set a real version (e.g. align with the graph) for the dry-run; if a real version bump is needed, treat it as a release-prep step and note it. If `pnpm publish -r --dry-run` cannot run in this environment (pnpm/registry), the IC captures the exact failure and we fall back to a `pnpm pack`/`npm pack --dry-run` per-package + a manual split-graph-pin check — **flag, do not fake**.

---

## 1. Stories

### `S7-01` — F1: `engagement({policies})` wiring
**Description:** `engagement(opts)` → `{ bridge, broadcasts }` composing the channel-agnostic chain + inbound resolver + stores from the injected policies/stores; `.bridge` spreads into `createMessagingRouter`.
**Acceptance criteria:**
1. `engagement({policies, consent?, ownership?, audit?, scheduler?, windowStore?, ledger?})` returns `{bridge, broadcasts}` per §0.
2. `bridge.outbound` = `[consentGate?, ownershipGate?, closedWindowRecovery(policies), interactiveRenderer(policies)]` (gates present only when the store is); `windowGuard` NOT included (router appends it). `bridge.inputResolver`, `bridge.windowStore`, `bridge.ownership`, `bridge.consent` wired.
3. `bridge` spreads into `createMessagingRouter({runtime, platforms, ...bridge})` and the resulting router constructs a valid `OutboundPipeline` (windowGuard terminal) — no constructor throw.
4. `policyInboundResolver(policies)` dispatches `resolveInbound` by `m.platform`; text catch-all.
5. `.broadcasts` is a `BroadcastApi` (wired per §0); document the wiring.
6. Tests: `engagement_composes_bridge` (bridge.outbound order + a router builds without throwing), `engagement_inbound_resolver_dispatches_by_platform`.
**Files:** `engagement/src/engagement.ts` (+ `policyInboundResolver`), `engagement/src/index.ts`; tests in `engagement/test/`.

### `S7-02` — F2: multi-platform example (3 channels)
**Description:** Extend `packages/kuralle-messaging-meta/examples/multi-platform/server.ts` to wire `engagement({policies:[whatsappPolicy(...), webPolicy(), instagramPolicy(...)]})` and demonstrate the SAME bot on WhatsApp + web + Instagram, offline fake-client. Plus a `same_bot_across_channels` E2E.
**Acceptance criteria:**
1. The example wires `engagement(...)` + `createMessagingRouter({..., ...engagement.bridge})` with all three policies; the SAME agent/flow set, no per-channel bot code.
2. Demonstrates: window-safety (closed-window per channel), buttons/list routing by id, handoff ownership, a WhatsApp broadcast-to-flow.
3. The example builds (`typecheck:all` sweeps it; if the example has its own tsconfig, it compiles).
4. `same_bot_across_channels` E2E (fake-client, offline): inbound from `whatsapp`/`web`/`instagram` produces correct per-channel rendering with no bot-code change.
5. Tests: `same_bot_across_channels` (E2E). Example builds.
**Files:** `packages/kuralle-messaging-meta/examples/multi-platform/server.ts` (+ README), a test under `engagement/test/` or `kuralle-e2e-tests/`.

### `S7-03` — F3: README + docs + publish-together dry-run
**Description:** Package README (`@kuralle-agents/engagement`) + a docs guide page; full `bun run typecheck:all` + the §9 test matrix green; publish-together dry-run (`pnpm publish -r --dry-run`) clean across the changed `@kuralle-agents/*` graph.
**Acceptance criteria:**
1. `packages/kuralle-engagement/README.md` documents the package (engagement layer, `engagement({policies})`, the gates/pipeline, broadcasts) — replaces the S0-01 stub.
2. A docs guide page (`apps/docs/` per repo convention, or a package-level guide) for the engagement layer.
3. `bun run typecheck:all` green; the §9 fail-to-pass matrix green (run the engagement + messaging + messaging-meta + core suites).
4. **Publish-together dry-run:** `pnpm publish -r --dry-run` from a neutral cwd shows the changed graph would publish together with no split-graph pin; `scripts/check-no-source-maps.sh` clean (no `.map` in tarballs). If a version bump is needed for the dry-run, do it as release-prep + note. If pnpm can't run here, fall back to `npm pack --dry-run` per package + a manual workspace:*-resolution / split-pin check and **flag** the limitation.
5. Tests/gate: typecheck:all green; full suite green; dry-run captured in the demo artifact.
**Files:** `packages/kuralle-engagement/README.md`, a docs guide page, possibly version bumps in the changed packages' `package.json`.

---

## 2. Universal DoD
Tests/gates green offline; `bun run build` + `typecheck:all` green; surfaces match RFC §4.5/§9; the example builds; publish dry-run clean (or honestly flagged); no `--no-verify`/suppression/silent-catch; atomic `[S7-{nn}]` commit + proof JSON; commit demo artifacts; no stray `*-implementation-notes.md`. Proof-schema cheat-sheet in every brief.

## 3. Test plan
| Story | Named tests / gates |
|-------|---------------------|
| S7-01 | `engagement_composes_bridge`, `engagement_inbound_resolver_dispatches_by_platform` |
| S7-02 | `same_bot_across_channels` (E2E), example builds |
| S7-03 | `typecheck:all` green; full §9 suite green; `pnpm publish -r --dry-run` clean (no split-pin, no `.map`) |

**Not tested (safe):** live Meta/AI sends (offline fake-client throughout); an actual publish (dry-run only — per platform rules, never a real publish without explicit ask); Messenger (BK-05).

## 4. Demo plan
Offline: the multi-platform example driven by the fake-client, one bot answering identically across WhatsApp + web + Instagram (window-safe, buttons/list by id, handoff, WA broadcast-to-flow); `typecheck:all` + suite green; `pnpm publish -r --dry-run` output (no split-pin, no `.map`).

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| `.broadcasts` underspecified in §4.5 (needs a pipeline the policies don't expose) | F1 can't wire broadcasts cleanly | concretize `engagement()` to accept the broadcast pipeline/ledger; document; deliver `bridge` rigorously regardless. |
| Composed chain breaks the terminal-guard invariant | router constructor throws | `windowGuard` NOT in `bridge.outbound` (router appends it terminal); test a router builds. |
| Publish dry-run can't run (pnpm/registry/env) | `pnpm publish -r --dry-run` errors | fall back to `npm pack --dry-run` per package + manual split-pin/`.map` check; **flag honestly, don't fake**. |
| Engagement `0.0.0` blocks the dry-run | version error | bump to a real version for the dry-run (release-prep); note it. |
| Example doesn't build (excluded from typecheck:all?) | stale example rots | ensure the example has a tsconfig in the sweep, or add a build-smoke; per repo gotcha "run examples, typecheck isn't enough" — at least typecheck it. |

## 6. Open questions
- `.broadcasts` wiring (§0/§4.5) — resolved by concretizing `engagement()`'s options; the IC documents the final shape. If it requires exposing platform clients on the policy (an interface change), **stop and flag** (that would be an RFC amendment).
- If the publish dry-run surfaces a real split-graph-pin or `.map` issue, that is a genuine finding to fix in the fix-pass, not to wave through.
