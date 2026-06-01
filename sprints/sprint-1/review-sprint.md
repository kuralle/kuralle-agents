# Sprint 1 — Manager Review (Phase B, sandwich, r1)

**Reviewer:** Opus 4.8 (1M) · 2026-06-01 · **Build branch:** `plan/whatsapp-engagement`
**Scope:** full sprint diff `5b0fcf2..b7121dc` (3 commits, 16 files, +865/−96), 3 briefs, 3 proceed-evidence files, 3 proof JSONs.
**Whole-sprint gate:** `bun run typecheck:all` → exit 0; `bun test {core,messaging,messaging-meta,engagement}` → **806 pass / 0 fail / 87 files**.

---

## 1. Strengths

- **The leak guarantee holds by construction.** `OutboundPipeline`'s constructor throws unless a `window-guard` middleware is present **and terminal** (`outbound-pipeline.ts` — `idx === -1` and `idx !== mw.length-1`), and `createMessagingRouter`'s `buildOutboundChain` always appends `windowGuard` last. The guard defers any free-form payload (text/media/interactive) when `meta.window.open === false`. There is no code path to emit a free-form payload past it.
- **Both bypasses are genuinely closed (REQ-17).** The router `fallbackMessage` now goes through `pipeline.send` (`createMessagingRouter.ts`), and the custom `responseMapper`'s `ResponseContext` closures are rebound to `sendFreeform → pipeline.send` (`stream-mapper.ts`) — a custom mapper *cannot* reach `platform.*` directly. `WhatsAppClient.sendTextOrTemplate` is `@deprecated`. Every send path is pipeline-routed.
- **Tests are behavioral, not shape-only.** `window-guard.test.ts` asserts, on a closed window, `sink.sendTextCalls / sendMediaCalls / sendInteractiveCalls === 0` with outcome `deferred`; `fallback_and_custom_mapper_route_through_pipeline` proves **both** the router fallback and a custom mapper reach **zero** client calls; an open-window test confirms the reply still fires (`>= 1`). The pipeline-constructor tests cover both the missing-guard and not-terminal failure modes.
- **Fail-closed propagates end-to-end.** `InMemoryWindowStore` (S0-04) returns `{open:false}` on a miss; the driver reads it into `meta.window`; the guard defers. A cold process leaks nothing.
- **The public-surface change is documented in the same change** (repo rule). The README "Window-safe outbound" subsection accurately describes the pipeline, the `MessagingRouterConfig.{windowStore,outbound}` additions, the `ResponseContext` closure-behavior change (synthetic `SendResult` on defer), and the `sendTextOrTemplate` deprecation.
- **Clean proofs all three stories** (no manager repair) — the proof-schema cheat-sheet baked into the briefs from story 1 eliminated the Sprint-0 friction.

## 2. Findings (file:line — severity — evidence — recommendation)

**Blockers:** none. **Majors:** none.

**Minor:**

1. **Section-banner comments stripped — `minor` (scope).** `createMessagingRouter.ts` lost several explanatory banner comments (`// Register message handler`, `// Track the messaging window`, etc.) while being edited — beyond the changed lines (a §3-surgical-changes nit). The removed comments were redundant section banners over self-documenting code (`windowStore.recordInbound`, `pipeline.send`). → **No action.** Restoring redundant banners is lower-value churn than leaving them out; noted so it's not a pattern.
2. **`sendTextOrTemplate` deprecated, not removed/wrapped — `minor` (intentional, R-02-S deferred).** It remains a callable direct-send escape for out-of-repo callers; only `@deprecated`. No internal caller uses it. → **No action this sprint;** full wrap/removal tracked in WARMDOWN (KI-1-01).
3. **`ResponseContext` closures return a synthetic `SendResult` (empty `messageId`) on a deferred/suppressed outcome — `minor` (documented).** A custom mapper that inspects the returned `messageId` sees `''` rather than a real id when a send defers. Documented in the README. → **No action;** acceptable for v1. Consumers needing the outcome can read it from the pipeline directly in a later sprint if required.

## 3. Verdict

**READY — sprint closes.** No blockers, no majors; three minors, none `Apply now`. The sprint goal — *every non-template outbound traverses an `OutboundPipeline` whose non-removable `windowGuard` makes a closed-window free-form send impossible to leak (it defers)* — is met and behaviorally proven (zero client free-form calls on a closed window, across default/custom-mapper/fallback paths). Public surfaces match RFC §4.1/§4.2; the `ResponseMapper`/`MessagingRouterConfig` reshape carries its README doc note. **No RFC amendment required.** No fix-pass code change needed → straight to warm-down.
