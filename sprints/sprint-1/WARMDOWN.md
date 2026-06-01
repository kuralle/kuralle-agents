# Sprint 1 — Warm-down

> **Author (main session):** Opus 4.8 (1M) · 2026-06-01.
> **Sprint window:** 2026-06-01 → 2026-06-08 (completed same-session).
> **Outcome:** Goal achieved — every outbound traverses the `OutboundPipeline`; a closed-window free-form send defers with zero client calls, proven by fake-client tests.

---

## 1. Goal recap

**Sprint goal (from WBS):** Every non-template outbound traverses an `OutboundPipeline` whose non-removable `windowGuard` makes a closed-window free-form send impossible to leak (it defers), proven by a fake-client test.

**Did we hit it?** **Yes.** The `OutboundPipeline` constructor refuses to build without a terminal `window-guard`; `createMessagingRouter` routes the default `StreamMapper` reply, the custom `responseMapper` (via rebound `ResponseContext` closures), and the router `fallbackMessage` all through it. On a closed window, free-form payloads (text/media/interactive) defer with **zero** client send calls; open-window sends still fire. Whole-sprint gate: `typecheck:all` green; **806 tests pass / 0 fail**.

---

## 2. Stories shipped

| Story | Status | Commit | Demo | Notes |
|-------|--------|--------|------|-------|
| S1-01 | Done | `d0e56a6` | [s1-01-tests.txt](./artifacts/s1-01-tests.txt) | `OutboundSink` / `OutboundTemplate` / `isTemplateCapable` (channel-neutral; no WA leak). |
| S1-02 | Done | `c26046a` | [s1-02-tests.txt](./artifacts/s1-02-tests.txt) | `OutboundPipeline` + middleware/`SendOutcome` types; constructor asserts `window-guard` present **and terminal**. |
| S1-03 | Done | `b7121dc` | [s1-03-tests.txt](./artifacts/s1-03-tests.txt) | `windowGuard` (defers closed-window free-form); `StreamMapper`→pipeline; both bypasses closed; `sendTextOrTemplate` deprecated. |

No stories slipped. No fix-pass code change (review found no `Apply now` items).

---

## 3. What's working

- **`OutboundPipeline` refuses an unsafe chain** — missing `window-guard` or non-terminal `window-guard` → constructor throws (`outbound-pipeline.test.ts`).
- **Closed-window free-form defers, zero client calls** — text/media/interactive (`window-guard.test.ts`: `sendTextCalls/sendMediaCalls/sendInteractiveCalls === 0`, outcome `deferred`).
- **Both bypasses closed** — router `fallbackMessage` and custom `responseMapper` both reach zero client calls on a closed window (`fallback_and_custom_mapper_route_through_pipeline`).
- **Open-window unaffected** — replies still send (regression test + 433 messaging tests green).
- **Fail-closed end-to-end** — cold `InMemoryWindowStore` → `{open:false}` → defer.

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-1-01 | `WhatsAppClient.sendTextOrTemplate` is `@deprecated` but still callable (direct-send escape for out-of-repo callers). Full wrap/removal behind the sink deferred (R-02-S). | minor | later (post-G1) | review §2.2 |
| KI-1-02 | Custom `responseMapper` closures return a synthetic `SendResult` (`messageId:''`) on a deferred send — a mapper inspecting `messageId` can't tell "deferred" from "sent". | minor | Sprint 2+ (expose `SendOutcome` if needed) | review §2.3 |
| KI-1-03 | `createMessagingRouter` lost some redundant section-banner comments during the S1-03 edit (cosmetic). | trivial | none | review §2.1 |

No blockers, no majors.

---

## 5. Decisions made

- **Decision:** Sprint 1's `windowGuard` **defers** on a closed window (does not convert to a template). **Rationale:** the strategist is Sprint 2 and the WhatsApp `ChannelPolicy` is Sprint 6; Sprint 1 is the pure leak-block. **Source:** PLAN §0. **RFC amendment:** none (RFC §6.1's strategist/policy branches arrive in Sprints 2/6).
- **Decision:** the `windowGuard` reads `req.meta.window`; the **driver** (`StreamMapper`/router) reads `WindowStore.get(threadId)` once per send and populates `meta.window`. **Rationale:** keeps the guard a pure, unit-testable function; the system still reads `WindowStore`; the only caller (`StreamMapper`) is trusted and the pipeline's terminal-guard assertion prevents bypass. **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** default outbound chain is `[windowGuard]`; `consentGate`/`ownershipGate` arrive with engagement (Sprint 4) via `config.outbound`/`engagement().bridge`. **Source:** PLAN §0.
- **Decision:** `ResponseContext` interface shape preserved; only the closures' target changed (to the pipeline). Deferred → synthetic `SendResult`. **Source:** brief-s1-03 §3/§5. **RFC amendment:** none (REQ-17 anticipated the reshape; documented in README).

---

## 6. Wiki / RFC amendments this sprint

No amendments. Public surfaces match RFC §4.1/§4.2; the `ResponseMapper`/`MessagingRouterConfig` reshape (REQ-17) is documented in `packages/kuralle-messaging/README.md`.

---

## 7. Metrics

- **Test count:** 806 across the 4 engagement-touched packages (added this sprint: 12 — 3 outbound-sink, 3 outbound-pipeline, 6 window-guard).
- **`typecheck:all`:** green.
- **Diff:** 3 story commits; +865/−96 across 16 files (+ Phase A/B markdown records committed at close).

---

## 8. Backlog updates

**Added:** none new. (KI-1-01 full `sendTextOrTemplate` wrap is a small future cleanup, not a backlog item yet.)
**Promoted / Removed:** none.

---

## 9. Retrospective

### Keep
**Baking the full proof-schema cheat-sheet into every brief from story 1** — all three Sprint-1 proofs passed the verifier first-try (vs three malformed proofs in Sprint 0). The Sprint-0 "Try next" experiment worked; keep it permanently in briefs. Independent manager re-verification (read diff + re-run tests + inspect test *assertions*, not just pass counts) again caught nothing wrong but confirmed the leak-guarantee tests were behavioral rather than shape-only.

### Change
The S1-03 IC stripped redundant section-banner comments while editing `createMessagingRouter.ts` (minor scope creep). Briefs already say "don't touch adjacent code"; consider an explicit "do not delete existing comments unless the code they describe is gone" line for edit-heavy stories.

### Try next
For Sprint 2 (strategist on the hot path), add a brief line requiring a **latency/short-circuit assertion in tests** (window-open ⇒ zero `TemplateSelector` calls) so the REQ-6 cost guarantee is proven, not assumed.

---

## 10. Pointers for the next sprint (Sprint 2 — Smart-send strategist)

- **Files to read first:** `packages/kuralle-engagement/src/policy.ts` (the `SmartSendStrategist` placeholder `TODO(S2-01)` to replace; `ClosedWindowStrategy{kind:'template', strategist}`), `packages/kuralle-messaging/src/types/outbound.ts` (`OutboundTemplate` — make it component-aware in B2), `packages/kuralle-messaging-meta/src/whatsapp/types.ts` (`TemplateInfo` ~367 lacks quality/paused — extend; `TemplateComponent` ~110), `packages/kuralle-messaging-meta/src/whatsapp/{templates.ts,client.ts}` (`sendTemplate` signature reconciliation OutboundTemplate↔TemplateMessage), `packages/kuralle-messaging/src/adapter/middleware/window-guard.ts` (Sprint 2's `strategistMiddleware` is what the closed-window path hands off to — in Sprint 1 it just defers).
- **Traps:** strategist is on the hot path → window-open MUST short-circuit (no `TemplateSelector` call, REQ-6); `catalog.approved()` cached; selector timeout → `defer`. The `OutboundTemplate`→WhatsApp `TemplateMessage` mapping (deferred from S1-01) must be reconciled in B2 when templates actually flow. The `windowGuard` currently *defers* on closed; Sprint 2 (B3) wires the strategist as the middleware the guard hands off to (or a `strategistMiddleware` before the guard) — keep `windowGuard` terminal.
- **Open RFC amendments in flight:** none. **Open issues blocking Sprint 2:** none.

---

## 11. Closeout

- [x] All shipped stories committed on `plan/whatsapp-engagement` (S1-01..S1-03).
- [x] No `Apply now` review items (none found).
- [x] `sprints/sprint-1/HANDOFF.md` written (local per .gitignore).
- [x] `sprints/STATE.md` updated (active pointer → Sprint 2 + load-bearing reading).
- [x] Demo artifacts archived under `sprints/sprint-1/artifacts/`.

Sprint 1 is closed.
