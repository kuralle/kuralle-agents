# Sprint 3 — Manager Review (Phase B, sandwich, r1)

**Reviewer:** Opus 4.8 (1M) · 2026-06-01 · **Build branch:** `plan/whatsapp-engagement`
**Scope:** full sprint diff `2760b2f..9a92305` (4 commits, 24 files, +1029/−14), 4 briefs, 4 proceed-evidence files, 4 proof JSONs.
**Whole-sprint gate:** `bun run typecheck:all` → exit 0; `bun test {core,messaging,messaging-meta,engagement}` → **853 pass / 0 fail / 95 files**.

---

## 1. Strengths

- **The tracked additive-risk was retired cleanly.** The `{type:'interactive'}` variant went into the **authoritative** `stream.ts` `HarnessStreamPart` only; `voice.ts`'s separate union is untouched (0 diff lines) with a doc-comment recording the intentional divergence. `typecheck:all` green + `interactive_part_is_additive` prove no exhaustive-switch broke — the WBS §5 risk is closed.
- **`ChoiceOption` relocation done right.** Moved to `core/src/types/selection.ts` (next to `ResolvedSelection`), exported from core, imported + re-exported by engagement — mirroring the established pattern. No shape change; both engagement importers updated.
- **Node-entry emit covers both paths.** The IC factored the emit into `flow/emitInteractive.ts` and called it from **both** `runFlow` (initial node) **and** `reduceTransition` (nodes reached via transition) — more complete than the brief (which named only `runFlow:142`). This is why a mid-flow `decide` correctly emits its choices.
- **Renderer rejects over-limit (R-11) — no silent slice.** `renderChoices` throws explicit errors on empty/>3 buttons/>10 list rows/over-length labels/malformed flow — the WhatsApp client's silent-slice behavior is replaced by a hard error at the engagement layer.
- **Stable-id routing, label-independent (REQ-8).** `InteractiveResolver` maps `interactive.id`/`button.payload`/`formResponse` → `{id|formData}`; `interactive_routes_by_id_not_label` proves identical ids with different titles drive the same transition. The `'[type]'` fallback was replaced by the resolver chain with **zero** messaging regression (444 → all green).
- **End-to-end composes the real seams.** `interactive_end_to_end` drives a live flow → real `interactiveRenderer` + `windowGuard` pipeline → recording sink (3 buttons) → inbound id-routing + formData. Behavioral, not shape-only.
- **All four proofs clean first-try; all demo artifacts committed** (the S2-03 untracked-artifact issue did not recur — brief hardening worked).

## 2. Findings

**Blockers:** none. **Majors:** none.

**Minor:**
1. **cta/url options mapped to a buttons action — `minor` (documented).** `InteractiveMessage` has no dedicated cta shape, so url options render as reply buttons. → No action; acceptable for v1 (a dedicated cta render can come with the WhatsApp policy in Sprint 6).
2. **`interactive` part `prompt` is best-effort display text — `minor` (documented).** Derived from the node's instruction text; may be empty for nodes without a clean prompt string. Routing is by id, so this is cosmetic. → No action.

No `Apply now` items.

## 3. Verdict

**READY — sprint closes.** No blockers, no majors, no `Apply now`. The goal — *a `collect`/`decide` renders buttons/list and inbound button/list/`nfm_reply` routes by stable id (label-independent), with free-text NLU fallback* — is met and behaviorally proven end-to-end. The additive `HarnessStreamPart` risk and the `ChoiceOption` relocation forward-trap are both resolved. Public surfaces match RFC §4.3/§4.5/§4.6 (additive); **no RFC amendment required.** No fix-pass code change → warm-down.
