# Sprint 2 — Plan

**Sprint name:** Smart-send strategist
**Sprint goal (one sentence):** A closed-window free-form send is converted to an APPROVED template by an injectable strategist (mock selector) behind deterministic guardrails, or deferred — with an audit record per conversion.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

---

## 0. Decisions made before briefing (read first)

- **How the strategist plugs into the pipeline (resolves the "terminal windowGuard" tension).** The `strategistMiddleware` is installed **before** the terminal `windowGuard` (via `MessagingRouterConfig.outbound`, the seam S1-03 added). On a send it calls `strategist.decide(req)`:
  - **window open** → `decide` returns `freeform` (no selector call, REQ-6) → middleware calls `next(req)` (unchanged free-form payload) → the `windowGuard` sees open → sends.
  - **window closed + a fitting APPROVED template** → `decide` returns `template` → middleware calls `next({...req, payload:{kind:'template', template}})` → the `windowGuard` passes templates (window-agnostic) → the sink sends it; outcome surfaced as `converted`.
  - **window closed + no fit / bad params / no approved template** → `decide` returns `defer` → middleware returns `{kind:'deferred', reason}` (never reaches the guard).
  The `windowGuard` stays **non-removable + terminal** — it is the backstop: if the strategist is absent or ever returned `freeform` on a closed window, the guard still defers the free-form payload. Strategist = recovery layer in front of the guard; guard = the leak-proof floor. This needs **no `ChannelPolicy`** (that unification is Sprint 6) and no change to the Sprint-1 `windowGuard`.
- **Package placement.** `strategist`, `TemplateSelector`, `TemplateCatalog`, `strategistMiddleware`, `smartSend`, `humanHandoff`-adjacent author surface live in **`@kuralle-agents/engagement`** (`src/{strategist,selector,catalog,strategist-middleware,nodes}.ts`). The `TemplateInfo` quality/paused extension + the component-aware `OutboundTemplate`→WhatsApp `TemplateMessage` mapping touch `messaging`/`messaging-meta`.
- **`OutboundTemplate` becomes component-aware (B2, R-10).** Add `components?: TemplateComponent[]` to `OutboundTemplate` — but `TemplateComponent` must stay **channel-neutral** in `messaging` (do NOT import WhatsApp's). Define a minimal neutral `OutboundTemplateComponent` in `messaging/src/types/outbound.ts`. The WhatsApp catalog/selector map neutral → Meta `TemplateMessage` when sending. (Keep `namedParams`/`positionalParams`/`raw` from S1-01; `components?` is additive.)
- **Catalog data source.** The WhatsApp-backed `TemplateCatalog.approved()` wraps `client.templates.list(wabaId)` → `TemplateInfo[]`, maps to `TemplateDescriptor[]`, and filters `status==='APPROVED'` AND not paused (quality !== 'PAUSED'/'DISABLED'). `TemplateInfo` (`whatsapp/types.ts:367`) gains optional `quality?` and `paused?` (R-10). `approved()` is cached (REQ-6 — no refetch on the hot path). Tests use a **mock catalog** (in-memory `TemplateDescriptor[]`); the WhatsApp impl's filter logic is unit-tested over fixtures.
- **`TemplateSelector` is the ONLY non-deterministic seam.** Tests inject a **mock selector**. The AI impl (Vercel AI SDK) is provided but not exercised in unit tests. Selector timeout/throw → `defer` (never block).

---

## 1. Stories

Order: **S2-01 → S2-02 → S2-03**. S2-01 builds the strategist against the interfaces; S2-02 supplies the concrete selector/catalog + type extensions; S2-03 wires it into the pipeline + the node.

### `S2-01` — B1: SmartSendStrategist + guardrails

**Description:** Implement `SmartSendStrategist` (`createSmartSendStrategist`) in `@kuralle-agents/engagement` per §4.4/§6.2 — guardrails run OUTSIDE the AI: window-open short-circuit; `catalog.approved()` filter; `selector.select(candidates)`; `catalog.validateParams`; `audit.record` before returning `template`; any failure → `defer`. Define the `SmartSendStrategist`/`SendDecision`/`TemplateSelector`/`TemplateCatalog`/`TemplateDescriptor`/`AuditSink`/`ConversionAudit`/`DeferReason` interfaces (the selector/catalog get concrete impls in S2-02; here they're interfaces + the strategist logic). Replace the `TODO(S2-01)` placeholder `SmartSendStrategist` in `engagement/src/policy.ts`.

**Acceptance criteria:**
1. `createSmartSendStrategist({catalog, selector, audit})` returns a `SmartSendStrategist` with `decide(input): Promise<SendDecision>` per §6.2.
2. Window-open ⇒ `{kind:'freeform', text}` with **zero** `selector.select` calls (REQ-6).
3. Closed window: `catalog.approved()` → empty ⇒ `{defer, reason:'no-approved-template'}`; selector returns null ⇒ `{defer, reason:'no-template-fit'}`; `validateParams` fails ⇒ `{defer, reason:'param-validation-failed'}`; success ⇒ `audit.record(...)` then `{template, selected, audit}`.
4. PAUSED/REJECTED templates never reach the selector (the strategist only passes `catalog.approved()` candidates — guardrail (a)).
5. The `policy.ts` placeholder is replaced with the real interface; `ClosedWindowStrategy{kind:'template', strategist}` references it; `engagement` still builds.
6. Tests (mock catalog + mock selector): `strategist_filters_paused_templates`, `strategist_defers_on_bad_params`, `strategist_audits_conversion`, `window_open_no_selector_call`.

**Files:** create `packages/kuralle-engagement/src/strategist.ts` (+ types, or a `types.ts`); modify `packages/kuralle-engagement/src/policy.ts` (replace placeholder, import real type), `packages/kuralle-engagement/src/index.ts`; create `packages/kuralle-engagement/test/strategist.test.ts`.

**Demo:** `sprints/sprint-2/artifacts/s2-01-tests.txt`.

### `S2-02` — B2: TemplateSelector seam + WhatsApp catalog + component-aware OutboundTemplate

**Description:** Provide the concrete `TemplateSelector` (AI, Vercel AI SDK, mockable) and `TemplateCatalog` (WhatsApp-backed: `client.templates.list` → filter APPROVED + non-paused → `TemplateDescriptor[]`, cached). Extend WhatsApp `TemplateInfo` with `quality?`/`paused?` (R-10). Make `OutboundTemplate` component-aware (neutral `OutboundTemplateComponent` in `messaging`) and provide the neutral→Meta `TemplateMessage` mapping.

**Acceptance criteria:**
1. `OutboundTemplate` gains `components?: OutboundTemplateComponent[]` (neutral type defined in `messaging/src/types/outbound.ts`; no WhatsApp import). Additive — S1 fields unchanged.
2. `TemplateInfo` (`whatsapp/types.ts`) gains optional `quality?: string` and `paused?: boolean` (R-10), populated from the Meta list response where available.
3. `whatsappTemplateCatalog({client, wabaId})` implements `TemplateCatalog`: `approved()` lists templates, filters `status==='APPROVED'` and non-paused, maps to `TemplateDescriptor[]`, and **caches** the result; `validateParams(name, params)` checks declared params.
4. `aiTemplateSelector(model)` implements `TemplateSelector` (Vercel AI SDK); on timeout/throw it surfaces as the strategist's `defer` (the selector itself may throw — the strategist catches). Mockable in tests.
5. Tests: `catalog_filters_approved_nonpaused` (a PAUSED/REJECTED template is excluded; an APPROVED non-paused one is included), `catalog_caches_approved` (second `approved()` call does not refetch). Selector is mocked elsewhere (S2-01); the AI impl gets a smoke/shape test only.
6. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-engagement packages/kuralle-messaging-meta` green.

**Files:** create `packages/kuralle-engagement/src/{selector,catalog}.ts`; modify `packages/kuralle-messaging/src/types/outbound.ts` (neutral component), `packages/kuralle-messaging-meta/src/whatsapp/types.ts` (TemplateInfo), possibly `packages/kuralle-messaging-meta/src/whatsapp/templates.ts` (mapping helper); `engagement/src/index.ts`; create tests `packages/kuralle-engagement/test/catalog.test.ts`.

**Demo:** `sprints/sprint-2/artifacts/s2-02-tests.txt`.

### `S2-03` — B3: strategistMiddleware + smartSend node

**Description:** `strategistMiddleware(strategist): OutboundMiddleware` (installed before the terminal `windowGuard`); and a `smartSend` action node that invokes the **same** strategist instance. The middleware and node share one strategist → identical decision for identical input (parity).

**Acceptance criteria:**
1. `strategistMiddleware(s)` returns an `OutboundMiddleware` (name e.g. `'strategist'`) that maps `s.decide(req)` → `freeform`⇒`next(req)`, `template`⇒`next({...req, payload:{kind:'template', template}})`, `defer`⇒`{kind:'deferred', reason}`. It is installable via `MessagingRouterConfig.outbound` and sits before `windowGuard` (which remains terminal).
2. `smartSend({id, message, intent?, next?})` returns an `action` node that calls the shared strategist's `decide` for the rendered message and routes via `next(decision, state)` (default transition if `next` absent).
3. **Parity test** `node_guard_parity`: for the same `(text, window, catalog, selector)` input, the decision produced via `strategistMiddleware` equals the one via the `smartSend` node (same strategist instance ⇒ same `SendDecision`).
4. A closed-window free-form send through a pipeline `[strategistMiddleware(s), windowGuard]` with a mock selector picking an approved template ⇒ outcome reaches the sink as a template (the guard passes it); a paused-only catalog ⇒ `deferred`.
5. Tests: `node_guard_parity`, `strategist_middleware_converts_closed_window`, `strategist_middleware_defers_when_no_fit`. Window-open ⇒ free-form passes with no selector call (carry the REQ-6 assertion here too).
6. `bun run build` + `typecheck:all` green; full `bun test` across touched packages green.

**Files:** create `packages/kuralle-engagement/src/{strategist-middleware,nodes}.ts`; modify `engagement/src/index.ts`; create `packages/kuralle-engagement/test/strategist-middleware.test.ts`.

**Demo:** `sprints/sprint-2/artifacts/s2-03-tests.txt` (closed-window text → mock selector picks `cart_reminder` → template reaches sink + audit row; paused excluded; bad params → defer).

---

## 2. Universal DoD (per story)

Same as Sprint 1 §2 (tests happy+failure offline; `bun run build` + `typecheck:all` green; no `HarnessStreamPart` change; surfaces match RFC §4.4; no `--no-verify`/suppression/silent-catch; atomic `[S2-{nn}]` commit + proof JSON). **No root `*-implementation-notes.md`** (repo policy). Proof-schema cheat-sheet in every brief.

---

## 3. Test plan

| Story | Named tests |
|-------|-------------|
| S2-01 | `strategist_filters_paused_templates`, `strategist_defers_on_bad_params`, `strategist_audits_conversion`, `window_open_no_selector_call` |
| S2-02 | `catalog_filters_approved_nonpaused`, `catalog_caches_approved` |
| S2-03 | `node_guard_parity`, `strategist_middleware_converts_closed_window`, `strategist_middleware_defers_when_no_fit` |

**Not tested (safe):** live AI selector (mocked — the only non-deterministic seam); live Meta templates API (catalog filter unit-tested over fixtures); `ChannelPolicy`-driven guard (Sprint 6); interactive rendering (Sprint 3).

## 4. Demo plan
Offline: closed-window text → mock selector picks `cart_reminder` → outcome `converted` + one `ConversionAudit`; a PAUSED template is excluded from candidates; bad params → `defer`; window-open → freeform, zero selector calls.

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| Strategist latency on the hot path (REQ-6) | a selector call fires on an open window | window-open short-circuit in `decide` **before** any catalog/selector call; test `window_open_no_selector_call`. |
| `catalog.approved()` refetch per send | network call on every in-window reply | cache `approved()`; test `catalog_caches_approved`. |
| Selector flakiness blocks sends | a thrown/timed-out selector aborts the pipeline | strategist catches selector throw/timeout → `defer`. |
| `OutboundTemplate` component-aware reshape leaks WhatsApp types into `messaging` | `messaging` imports `messaging-meta` | define a **neutral** `OutboundTemplateComponent` in `messaging`; map to Meta shape in `messaging-meta`/`engagement`. |
| strategistMiddleware ordering breaks the terminal-guard invariant | pipeline constructor throws / guard not last | install strategist via `config.outbound` (before guard); guard stays terminal; covered by S1-02 assertion. |

## 6. Open questions
None blocking. If S2-02 finds the Meta list response does not expose `quality`/`paused` in the current `graphApi.get` shape, model them as optional and populate when present (do not block); flag if the filter can't distinguish paused templates at all.
