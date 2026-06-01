# Proceed Evidence — `S1-03` A3: windowGuard + pipeline wiring + close bypasses

> **Manager artifact — Phase A only.** Phase A complete after this.

## Story
- **Id:** `S1-03` · **Commit:** `b7121dc` — `[S1-03] A3 windowGuard + pipeline wiring + close bypasses` · **Slug:** `s1-03` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — scope matches brief §3: new `middleware/window-guard.ts`; reshaped `stream-mapper.ts` (every send → `pipeline.send`, custom-mapper closures rebound, can't reach `platform.*`); `createMessagingRouter.ts` (per-platform `OutboundPipeline(buildOutboundChain(config.outbound))` with `windowGuard` terminal, `InMemoryWindowStore`, fallback routed through `pipeline.send`); `types/adapter.ts` (`MessagingRouterConfig.{outbound,windowStore}`, `StreamMapperOptions.{pipeline,windowStore,sessionId,userId}`); `whatsapp/client.ts` (`@deprecated sendTextOrTemplate`); README "window-safe outbound" note; tests.
- [x] **Leak guarantee correct by construction** — `windowGuard` defers free-form (text/media/interactive) when `meta.window.open === false`, passes templates + open-window. `buildOutboundChain` always appends `windowGuard` last (terminal — pipeline constructor enforces). Default `InMemoryWindowStore` fails closed on a miss (S0-04), so a cold thread defers.
- [x] **Both bypasses closed (REQ-17):** router `fallbackMessage` goes through `pipeline.send` (not `platform.sendText`); custom `responseMapper` context closures call `sendFreeform`→`pipeline.send` (never `platform.*`). `ResponseContext` interface shape preserved (closures return `SendResult`; deferred/suppressed → synthetic empty `SendResult` — documented IC choice).
- [x] **`verify-handoff-proof.sh s1-03` → `PROOF_OK`** (4 claims, 7 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-1`, `REQ-16`, `REQ-17`, `test:window_closed_blocks_freeform`, `test:window_closed_blocks_media_and_interactive`, `test:fallback_and_custom_mapper_route_through_pipeline`, `cmd:typecheck_all`).
- [x] **Independent manager verification (empirical):** `bun run build` exit 0; `window-guard.test.ts` → **6 pass / 0 fail**; full `bun test packages/kuralle-messaging` → **433 pass / 0 fail**; `bun test packages/kuralle-messaging-meta` → **303 pass / 0 fail**; `typecheck:all` green. **Inspected the test assertions** — genuinely behavioral: closed window ⇒ `sendTextCalls/sendMediaCalls/sendInteractiveCalls === 0` + `deferred`; fallback + custom mapper both reach **0** client calls on closed window; open-window reply still fires (`>=1`). Not shape-only.
- [x] No `--no-verify`/type-suppression. Demo artifact present. No stray root notes file.

**Verdict:** `PROCEED` — **Phase A complete (all 3 stories `PROCEED`).**

## One-line summary
Every outbound (default, custom mapper, router fallback) traverses the `OutboundPipeline` with a non-removable terminal `windowGuard`; closed-window free-form defers with zero client calls · 433 messaging + 303 meta tests green · proof `s1-03` · commit `b7121dc`.

## Notes
- **Minor (for Phase B):** the IC stripped several section-banner comments from `createMessagingRouter.ts` while editing (mild scope creep beyond the changed lines). Code is correct; comments were largely redundant. Will note in review; not blocking.
- **`ResponseContext` behavior change** is documented in the README ("window-safe outbound" subsection) per brief §5 — public surface shape preserved, only the closures' target changed. RFC §4.3 anticipated this reshape (REQ-17).
- **`sendTextOrTemplate`** deprecated, not removed (external callers); no internal caller uses it. Full wrap/removal deferred (note in WARMDOWN).
