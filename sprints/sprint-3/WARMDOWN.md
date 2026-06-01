# Sprint 3 — Warm-down

> **Author:** Opus 4.8 (1M) · 2026-06-01 (long-running program mode).
> **Outcome:** Goal achieved — `collect`/`decide` render WhatsApp buttons/list and inbound button/list/`nfm_reply` route the flow by stable id, label-independent, with free-text fallback.

---

## 1. Goal recap
**Sprint goal:** A `collect`/`decide` renders WhatsApp buttons/list and inbound button/list/`nfm_reply` routes the flow by stable id (label-independent), with free-text NLU fallback.
**Did we hit it?** **Yes.** Additive `{type:'interactive'}` stream part + `choices?` metadata emit on node entry; `interactiveRenderer` renders buttons(≤3)/list(≤10)/cta/Flow and rejects over-limit; `InboundResolverChain` routes by stable id; `withChoices` + an end-to-end test stitch it together. Gate: `typecheck:all` green; **853 tests / 0 fail**.

---

## 2. Stories shipped
| Story | Status | Commit | Demo |
|-------|--------|--------|------|
| S3-01 | Done | `01767de` | [s3-01-tests.txt](./artifacts/s3-01-tests.txt) |
| S3-02 | Done | `cb321b1` | [s3-02-tests.txt](./artifacts/s3-02-tests.txt) |
| S3-03 | Done | `83a4215` | [s3-03-tests.txt](./artifacts/s3-03-tests.txt) |
| S3-04 | Done | `9a92305` | [s3-04-tests.txt](./artifacts/s3-04-tests.txt) |
No stories slipped; no fix-pass code change (review found no `Apply now`).

---

## 3. What's working
- **Additive interactive stream part** (authoritative `stream.ts`; voice.ts untouched) — `interactive_part_is_additive`.
- **Emit on node entry** (both initial + transition paths) — `interactive_emitted_on_node_entry`.
- **Renderer picks buttons/list + rejects over-limit** (no silent slice, R-11) — `render_picks_buttons_then_list`, `renderer_rejects_over_limit`.
- **Stable-id routing, label-independent** + nfm_reply formData + free-text fallback — `interactive_routes_by_id_not_label`, `template_button_payload_routes`, `nfm_reply_form_in_state`, `free_text_nlu_fallback`.
- **End-to-end** emit→render→route — `interactive_end_to_end`.

---

## 4. Known issues
| ID | Description | Severity |
|----|-------------|----------|
| KI-3-01 | cta/url options render as reply buttons (`InteractiveMessage` has no dedicated cta shape). | minor |
| KI-3-02 | `interactive` part `prompt` is best-effort display text (may be empty); routing is by id, so cosmetic. | minor |

No blockers/majors.

---

## 5. Decisions made
- **Decision:** `interactive` variant in `stream.ts` only (authoritative); `voice.ts` untouched. **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** `ChoiceOption` relocated to `@kuralle-agents/core` (S0-04 forward trap resolved). **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** emit on node entry from both `runFlow` (initial) and `reduceTransition` (post-transition). **Rationale:** a mid-flow node reached via transition must also emit its choices. **Source:** IC (exceeded brief). **RFC amendment:** none.

---

## 6. RFC amendments
No amendments. Surfaces match RFC §4.3/§4.5/§4.6 (additive).

---

## 7. Metrics
- **Test count:** 853 (added this sprint: 27). **`typecheck:all`:** green. **Diff:** 4 commits, +1029/−14 across 24 files.

---

## 8. Backlog updates
None.

---

## 9. Retrospective
### Keep
The "prove additive as a proof assertion" experiment (from Sprint 2's Try-next) worked — S3-01's proof required `typecheck:all` + an additive-consumer test, and the tracked `HarnessStreamPart` risk closed without drama. All four demo artifacts were committed (the S2-03 untracked-artifact slip didn't recur after the brief hardening).
### Change
Nothing material — four clean first-try proofs. The IC's two-emit-site improvement (runFlow + reduceTransition) shows briefs can under-specify; keep encouraging ICs to cover all paths (the brief named one emit site; the IC found both).
### Try next
Sprint 4 (handoff & consent) adds an **inbound** ownership gate (suppress `runtime.run` while human-owned) — add a brief assertion that the gate is checked on the inbound path **before** `runtime.run` (outbound suppression alone is insufficient, REQ-21); make "no side effects fire while human-owned" a behavioral test (assert `runtime.run` not called), not just "outbound count 0".

---

## 10. Pointers for the next sprint (Sprint 4 — Handoff & consent)
- **Files to read first:** `packages/kuralle-engagement/src/` (new `ownership.ts`, `consent.ts`), `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` (the **inbound** ownership gate goes here — before `runtime.run`; the `onMessage` handler), `packages/kuralle-core/src/runtime/Runtime.ts` (S0-05 `terminalHandoffTargets` — `escalate→'human'` already pauses+emits a `handoff` part; the engagement `ownershipGate` consumes that to `ownership.claim`), `packages/kuralle-messaging/src/types/outbound.ts` (`SendOutcome` has `suppressed` — `consentGate`/`ownershipGate` short-circuit to it), `SessionStore` (ownership/consent are SessionStore-backed; consent keyed by **customerId** not thread — REQ-19).
- **Traps:** the ownership gate must run on **inbound** before `runtime.run` (REQ-21 — outbound suppression alone is insufficient because the runtime fires side effects on inbound); consent keyed by `customerId` (S0-02), ownership/window by conversation; `STOP` handler opts out + halts drips; gates are `OutboundMiddleware` installed before the terminal `windowGuard`.
- **Seams to build on:** S0-05 terminal handoff (`escalate→'human'` pauses + emits `handoff`), S1 pipeline + `config.outbound` middleware slot, S0-02 `customerId`.
- **Open RFC amendments:** none. **Open blockers:** none.

---

## 11. Closeout
- [x] All stories committed (S3-01..04). [x] No `Apply now`. [x] HANDOFF written (local). [x] STATE → Sprint 4. [x] Artifacts archived.
Sprint 3 is closed.
