# Sprint 2 — Manager Review (Phase B, sandwich, r1)

**Reviewer:** Opus 4.8 (1M) · 2026-06-01 · **Build branch:** `plan/whatsapp-engagement`
**Scope:** full sprint diff `697f673..d45d0e4` (3 commits, 21 files, +1194/−11), 3 briefs, 3 proceed-evidence files, 3 proof JSONs.
**Whole-sprint gate:** `bun run typecheck:all` → exit 0; `bun test {core,messaging,messaging-meta,engagement}` → **826 pass / 0 fail / 91 files**.

---

## 1. Strengths

- **Guardrails are genuinely outside the AI (REQ-5).** `createSmartSendStrategist.decide` short-circuits window-open to `freeform` with **zero** selector calls (REQ-6); on a closed window it filters to `catalog.approved()` candidates, rejects a selector pick that isn't in-set, validates params, audits *before* returning `template`, and defers on every failure mode (empty catalog / null pick / selector throw / bad params). The AI proposes; deterministic code disposes.
- **The strategist-before-terminal-guard design preserves the Sprint-1 invariant.** `strategistMiddleware` (installed via `config.outbound`, before the terminal `windowGuard`) converts closed-window **text** → template so the now-template payload passes the guard; the `windowGuard` stays non-removable + terminal and still defers any free-form (incl. media/interactive) the strategist didn't convert. The leak floor is intact; the strategist is a recovery layer in front of it.
- **One strategist, two entry points (REQ-4).** `strategistMiddleware` and the `smartSend` action node share a single `SmartSendStrategist` instance → identical `SendDecision` for identical input (`node_guard_parity`). `smartSend` is an `action` node — no new `FlowNode` kind (REQ-9).
- **No WhatsApp type leaks into `messaging`.** `OutboundTemplate` became component-aware via a **neutral** `OutboundTemplateComponent` defined in `messaging`; the WhatsApp mapping lives in `messaging-meta`. `grep -rq messaging-meta packages/kuralle-messaging/src` is clean.
- **Catalog caches + filters correctly.** `whatsappTemplateCatalog.approved()` fetches `client.templates.list` once (cache guard), maps to `TemplateDescriptor`, filters APPROVED + non-paused; `TemplateInfo` extended with `quality?`/`paused?` (R-10). Cost on the hot path is bounded (REQ-6).
- **Clean proofs all three stories;** the IC correctly confirmed the real `Transition` idiom (`'stay'`) rather than guessing the brief's placeholder.

## 2. Findings (file:line — severity — evidence — recommendation)

**Blockers:** none. **Majors:** none.

**Minor:**

1. **`s2-03-tests.txt` demo artifact left untracked — `minor` (DoD gap).** The S2-03 IC created `sprints/sprint-2/artifacts/s2-03-tests.txt` but did not `git add` it in commit `d45d0e4`. → **Apply now (manager):** commit it with the closeout. (Trivial; no code impact.)
2. **Sprint 2 recovers text only on a closed window — `minor` (intended scope).** `strategistMiddleware` passes non-text (media/interactive) through to the terminal guard, which defers them. Matches the demo and §0; media/interactive recovery is not in scope (and Meta has no template path for them anyway). → **No action;** documented.
3. **AI `aiTemplateSelector` exercised only by a shape test — `minor` (intended).** The selector is the sole non-deterministic seam and is mocked in the strategist/middleware tests; the live AI path is unverified offline (by design). → **No action;** the strategist catches selector throw/timeout → `defer`, so a flaky selector can't leak or block.

## 3. Verdict

**READY — sprint closes.** No blockers, no majors. One `Apply now` (commit the untracked S2-03 demo artifact — handled in closeout); two documented minors. The sprint goal — *a closed-window free-form send is converted to an APPROVED template by an injectable strategist behind deterministic guardrails, or deferred, with an audit per conversion* — is met and behaviorally proven (closed-window text → template at the sink; PAUSED excluded; bad params/no fit → defer + zero send). Public surfaces match RFC §4.4; `StrategistInput`/`ConversionAudit` shapes are a documented gap-fill of the under-specified RFC, **not a divergence** — no RFC amendment required.
