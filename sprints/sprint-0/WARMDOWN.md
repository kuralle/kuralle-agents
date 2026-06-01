# Sprint 0 — Warm-down

> **Author (main session):** Opus 4.8 (1M) · 2026-06-01.
> **Sprint window:** 2026-06-01 → 2026-06-08 (completed same-session).
> **Outcome:** Goal achieved — the scaffold + all five additive core seams landed, additive and green.

---

## 1. Goal recap

**Sprint goal (from WBS):** Scaffold `@kuralle-agents/engagement` and land the additive core seams so a flow run threads a structured `selection` into flow state and `escalate→'human'` pauses (not throws), proven by unit tests.

**Did we hit it?** **Yes.** The `@kuralle-agents/engagement` package exists and builds in the topological tier; `RunOptions.selection` merges `formData` into flow state before the first effect and routes `selection.id` as input (durable-replay safe); `escalate→'human'` pauses + emits a `handoff` part instead of throwing a missing-agent error. `WindowStore` (fail-closed) and the `ChannelPolicy`/`webPolicy` seam are in place for Sprint 1. Whole-sprint gate: `bun run typecheck:all` green; **794 tests pass / 0 fail** across the four touched packages.

---

## 2. Stories shipped

| Story | Status | Commit | Demo | Notes |
|-------|--------|--------|------|-------|
| S0-01 | Done | `2dffb53` | [s0-01-build.txt](./artifacts/s0-01-build.txt) | Scaffold `@kuralle-agents/engagement` + T3 build tier. |
| S0-02 | Done | `c53197f` | [s0-02-tests.txt](./artifacts/s0-02-tests.txt) | `InboundMessage.customerId`/`button`/`interactive.formResponse`; WA `nfm_reply` parse (failure-safe); resolver no double-prefix. |
| S0-03 | Done | `755eb21` | [s0-03-tests.txt](./artifacts/s0-03-tests.txt) | `RunOptions.selection` → merge `formData` into `runState.state` before first effect; `selection.id` as input. |
| S0-04 | Done | `0594287` | [s0-04-tests.txt](./artifacts/s0-04-tests.txt) | `WindowStore`/`InMemoryWindowStore` (fail-closed); `ChannelPolicy`/`ClosedWindowStrategy` + `webPolicy()`. |
| S0-05 | Done | `5aafa8f` | [s0-05-tests.txt](./artifacts/s0-05-tests.txt) | `Runtime.terminalHandoffTargets` (default `['human']`) → pause + emit `handoff`, no missing-agent throw. |

No stories slipped. Manager fix pass: `82a3296` (`[S0-fix]`).

---

## 3. What's working

- **`engagement` package builds + sweeps** in CI (`s0-01-build.txt`; 58 tsconfigs in `typecheck:all`).
- **Structured inbound survives normalization** — WA `toInboundMessage` populates `button.payload` and `interactive.formResponse` (parsed `nfm_reply.response_json`, failure-safe), `customerId` on all three meta clients (`s0-02-tests.txt`).
- **`session_id_not_double_prefixed`** — resolver yields `whatsapp:{pnid}:{from}`, not `whatsapp:whatsapp:…`.
- **`selection` propagation is durable-replay safe** — `formData` merges into `runState.state` and persists before the first effect; resume re-applies idempotently (`s0-03-tests.txt`, 3 tests incl. replay).
- **`WindowStore` fails closed** on a store miss (`window_store_fail_closed`); `webPolicy` never gates (`web_null_policy_always_open`).
- **`escalate→'human'` no longer throws** — full escalate→signal→resume path pauses + emits exactly one `handoff` part; direct `{handoff:'human'}` pauses with empty `handoffHistory` (`s0-05-tests.txt`, 2 behavioral tests).

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-0-01 | Terminal-handoff **double-emit**: an explicit `{handoff:'human'}` transition emits a `handoff` part in `runFlow.ts:157` and again in `Runtime.ts:179`. Informational/idempotent; consumers ignore dups. | minor | Sprint 4 (touches this path for the ownership gate) | review-sprint.md §2.2 |
| KI-0-02 | `ChoiceOption` defined in `engagement` but Sprint 3 (C1) adds it to core `stream.ts`; core can't import engagement → likely relocate to core + re-export. | minor (forward) | Sprint 3 | review-sprint.md §2.3 |
| KI-0-03 | `SmartSendStrategist` is a forward-declared placeholder (`policy.ts:13`, `TODO(S2-01)`). | minor (forward) | Sprint 2 | PLAN §0 |
| KI-0-04 | `InMemoryWindowStore` is single-process only; durable adapter is backlog **BK-06** (REQ-18). | known/expected | backlog | WBS §4 BK-06 |

No blockers, no majors.

---

## 5. Decisions made

- **Decision:** Package is `@kuralle-agents/engagement` at `packages/kuralle-engagement/`. **Rationale:** RFC is internally inconsistent (older §4.4/§5.1 say `whatsapp-engagement`); **REQ-22 (rev3, latest)** + the WBS say `engagement`. The RFC's latest revision wins. **Source:** PLAN §0. **RFC amendment:** none (following REQ-22 as written; the stale prose is an editorial defect, not a divergence).
- **Decision:** `ResolvedSelection` is owned by `@kuralle-agents/core`. **Rationale:** `messaging` depends on `core`, never the reverse; defining it twice would split the type. **Source:** PLAN §0. **RFC amendment:** none (§4.8 names the type; ownership is an implementation detail).
- **Decision:** `InboundMessage.customerId` is a **required** field. **Rationale:** REQ-19 wants identity always-present; required enforces it at compile time. All 3 meta clients + test fixtures updated. **Source:** brief-s0-02 §6. **RFC amendment:** none.

---

## 6. Wiki / RFC amendments this sprint

No amendments this sprint. Public surfaces (§4.8–4.12, REQ-19/20/22/23) match the diff as written.

---

## 7. Metrics

- **Test count:** 794 across the 4 touched packages (added this sprint: 3 selection + 2 terminal-handoff + WA inbound + window-store + web-policy ≈ 9 new behavioral tests across ~5 files; existing fixtures updated for `customerId`).
- **`typecheck:all`:** 58 framework tsconfigs swept + 7 playground + lint — green.
- **Diff size:** 5 story commits + 1 fix commit; +947/−31 across 38 files (Phase A code/tests + Phase A/B markdown records).
- **New package:** `@kuralle-agents/engagement` (`0.0.0`, builds in T3).

---

## 8. Backlog updates

**Added:** none new (BK-06 durable `WindowStore` already tracked in WBS §4).
**Promoted:** none.
**Removed:** none.

---

## 9. Retrospective

### Keep
The **proceed-evidence loop with independent manager re-verification** worked exactly as intended: every story's substance was confirmed by re-running build + targeted tests + regression (not by trusting IC chat or sidecars), and the diff was read line-by-line before `PROCEED`. Pre-writing all five briefs up front (with full source recon baked in — exact `file:line` anchors, the `customerId` cascade, the `nfm_reply` type gap, the merge point) meant each IC fired immediately on the prior story's `PROCEED` with zero mid-flight clarification.

### Change
Cursor's **proof-JSON discipline was the recurring friction** — three of five proofs were initially malformed (invalid `claims[].type` enums; `claim_id` vs `id` + missing `stdout_sidecar`; free-text `purpose` instead of `verification`). The *work* was clean every time; only the proof encoding failed the verifier. Each was a mechanical manager fix after independent substance-verification, but it cost cycles.

### Try next
Carry a **"proof schema cheat-sheet" block** verbatim into every story brief from the start (valid `type` enums, `id` = sidecar basename, `stdout_sidecar` required, `purpose:"verification"`). It was added incrementally this sprint (S0-03 onward) and S0-03/04/05 proofs were progressively cleaner — bake the full version into Sprint 1's first brief.

---

## 10. Pointers for the next sprint

- **Files to read first:** the new seams S1 builds on — `packages/kuralle-messaging/src/adapter/window-store.ts` (Sprint 1 wires `windowGuard` to read this), `packages/kuralle-engagement/src/policy.ts` (`ChannelPolicy`), `packages/kuralle-messaging/src/types/{messages.ts,adapter.ts}`, `packages/kuralle-messaging/src/adapter/{createMessagingRouter,stream-mapper}.ts` (the bypasses S1 must close per REQ-17).
- **Traps:** stale-dist (rebuild `core`/`messaging` after editing their `src` before testing dependents); the `responseMapper` reshape in S1 (A3) is a public-surface change — needs a doc note; the router `fallbackMessage` (`createMessagingRouter.ts:81`) and custom `responseMapper` (`stream-mapper.ts:82-89`) are the two direct-send bypasses S1 must route through the pipeline.
- **Open RFC amendments in flight:** none.
- **Open issues blocking Sprint 1:** none.

---

## 11. Closeout

- [x] All shipped stories committed on `plan/whatsapp-engagement` (S0-01..S0-05) + fix pass (`82a3296`).
- [x] All `Apply now` items from the review resolved (the 4 stray notes files removed).
- [x] Backlog deltas reviewed (no new; BK-06 already tracked).
- [x] `sprints/sprint-0/HANDOFF.md` written.
- [x] `sprints/STATE.md` updated (active pointer → Sprint 1 + load-bearing reading).
- [x] Demo artifacts archived under `sprints/sprint-0/artifacts/`.

Sprint 0 is closed.
