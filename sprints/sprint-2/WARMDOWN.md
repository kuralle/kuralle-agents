# Sprint 2 — Warm-down

> **Author (main session):** Opus 4.8 (1M) · 2026-06-01.
> **Sprint window:** 2026-06-01 → 2026-06-08 (completed same-session, long-running program mode).
> **Outcome:** Goal achieved — a closed-window free-form (text) send is converted to an APPROVED template by an injectable strategist behind deterministic guardrails, or deferred, with an audit per conversion.

---

## 1. Goal recap

**Sprint goal (from WBS):** A closed-window free-form send is converted to an APPROVED template by an injectable strategist (mock selector) behind deterministic guardrails, or deferred — with an audit record per conversion.

**Did we hit it?** **Yes.** `createSmartSendStrategist` runs guardrails outside the AI (window-open short-circuit → approved-only candidates → selector → validate → audit → template; any failure → defer). `strategistMiddleware` (before the terminal `windowGuard`) converts closed-window text→template; `smartSend` shares the same strategist (parity). The WhatsApp catalog filters APPROVED + non-paused and caches. Gate: `typecheck:all` green; **826 tests / 0 fail**.

---

## 2. Stories shipped

| Story | Status | Commit | Demo | Notes |
|-------|--------|--------|------|-------|
| S2-01 | Done | `fea0479` | [s2-01-tests.txt](./artifacts/s2-01-tests.txt) | `SmartSendStrategist` + guardrails; placeholder replaced. |
| S2-02 | Done | `dd87fad` | [s2-02-tests.txt](./artifacts/s2-02-tests.txt) | `aiTemplateSelector` + `whatsappTemplateCatalog` (filter+cache) + neutral component-aware `OutboundTemplate` + `TemplateInfo.quality?/paused?`. |
| S2-03 | Done | `d45d0e4` | [s2-03-tests.txt](./artifacts/s2-03-tests.txt) | `strategistMiddleware` + `smartSend` node (shared strategist, parity). |

No stories slipped. Fix pass: only the untracked S2-03 demo artifact, committed at closeout (no code change).

---

## 3. What's working

- **Window-open → freeform, zero selector calls** (`window_open_no_selector_call`) — REQ-6 cost guarantee.
- **Closed-window text → APPROVED template** with an audit row (`strategist_audits_conversion`, `strategist_middleware_converts_closed_window`).
- **PAUSED/REJECTED never reach the selector** (`strategist_filters_paused_templates`, `catalog_filters_approved_nonpaused`).
- **Bad params / no fit / selector error → defer** (`strategist_defers_on_bad_params`, `strategist_middleware_defers_when_no_fit`).
- **Catalog caches** `approved()` (`catalog_caches_approved`).
- **Node↔guard parity** — one strategist, identical decision (`node_guard_parity`).

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-2-01 | Sprint 2 recovers **text only** on a closed window; media/interactive defer at the terminal guard (no Meta template path for them). | minor (intended) | — | review §2.2 |
| KI-2-02 | `aiTemplateSelector` live AI path unverified offline (mocked everywhere); only a shape test. Strategist catches throw/timeout → defer, so a flaky selector can't leak/block. | minor (intended) | live-smoke later | review §2.3 |
| KI-1-01 | (carried) `WhatsAppClient.sendTextOrTemplate` still `@deprecated` not removed. | minor | post-G1 | sprint-1 review |

No blockers, no majors.

---

## 5. Decisions made

- **Decision:** `strategistMiddleware` installs **before** the terminal `windowGuard` (via `config.outbound`) and converts closed-window text→template; the guard stays the non-removable backstop. **Rationale:** preserves the Sprint-1 terminal-guard invariant while adding recovery; needs no `ChannelPolicy` (Sprint 6). **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** `OutboundTemplate` component-awareness uses a **neutral** `OutboundTemplateComponent` in `messaging`; WhatsApp mapping in `messaging-meta`. **Rationale:** no WhatsApp type leak (REQ-14). **Source:** brief-s2-02. **RFC amendment:** none.
- **Decision:** `StrategistInput`/`ConversionAudit` concrete shapes (gap-fill of under-specified RFC §4.4). **Source:** brief-s2-01 §3. **RFC amendment:** none (no divergence).

---

## 6. Wiki / RFC amendments this sprint

No amendments. Public surfaces match RFC §4.4.

---

## 7. Metrics

- **Test count:** 826 (added this sprint: 20 — strategist 8, catalog 3, selector 2, strategist-middleware 7).
- **`typecheck:all`:** green. **Diff:** 3 story commits; +1194/−11 across 21 files.

---

## 8. Backlog updates

**Added:** none. **Promoted/Removed:** none.

---

## 9. Retrospective

### Keep
The proof-schema cheat-sheet + independent re-verification continue to pay off — all three Sprint-2 proofs were clean first-try and the manager re-ran every test suite + read the guardrail logic line-by-line (confirming the "selector must stay in-set" guard and audit-before-template ordering). Pre-writing all three briefs with concrete interface signatures (filling the RFC's under-specified `StrategistInput`/`ConversionAudit`) meant zero mid-flight ambiguity.

### Change
A demo artifact was created but left untracked by the S2-03 IC (caught at Phase B). The brief says "commit it" but the IC's `git add` missed it. Add an explicit proof claim `file:demo_artifact_committed` (a `git ls-files` check) to future briefs so the proof gate catches an uncommitted artifact rather than the manager catching it at review.

### Try next
For Sprint 3 (interactive fidelity touches the additive `HarnessStreamPart` variant — the tracked risk), add a brief line requiring a test that proves the new stream variant is **additive** (an existing exhaustive switch still compiles / a consumer ignores the unknown variant) — make the "additive" claim a proof assertion, not an assumption.

---

## 10. Pointers for the next sprint (Sprint 3 — Interactive fidelity)

- **Files to read first:** `packages/kuralle-core/src/types/stream.ts` (add `{type:'interactive'}` variant — the tracked additive-risk; note there may be a second union in `types/voice.ts`), `packages/kuralle-core/src/flow/{nodeKinds or flow.ts,runFlow.ts}` (optional `choices` metadata on `collect`/`decide` + emit on node entry), `packages/kuralle-engagement/src/policy.ts` (`ChoiceOption` — Sprint 3 may relocate it to core per the S0-04 forward trap, since core's stream variant needs it and core can't import engagement), `packages/kuralle-messaging/src/adapter/` (the `InboundResolverChain`/`InteractiveResolver`/`TextResolver` replacing the `input = message.text ?? '[type]'` derivation in `createMessagingRouter.ts`), `packages/kuralle-messaging-meta/src/whatsapp/client.ts` (`toInboundMessage` already parses `nfm_reply`/`button` from S0-02 — Sprint 3's resolver reads those fields), the interactive renderer (buttons ≤3 / list ≤10 / cta / Flows, **explicit limit error, no silent slice** — `client.ts:340`).
- **Traps:** **two `HarnessStreamPart` unions** (`types/stream.ts` + `types/voice.ts`) may drift — add the variant to the authoritative text/stream union and document which is authoritative; `typecheck:all` gate proves exhaustive switches still compile. `ChoiceOption` likely must move to core (S0-04 forward trap) — relocate + re-export from engagement. The renderer must **reject** over-limit (no silent slice — R-11).
- **Open RFC amendments:** none. **Open blockers:** none.

---

## 11. Closeout

- [x] All stories committed on `plan/whatsapp-engagement` (S2-01..S2-03).
- [x] `Apply now` review item resolved (S2-03 demo artifact committed at closeout).
- [x] `sprints/sprint-2/HANDOFF.md` written (local per .gitignore).
- [x] `sprints/STATE.md` → Sprint 3 + load-bearing reading.
- [x] Demo artifacts archived under `sprints/sprint-2/artifacts/`.

Sprint 2 is closed.
