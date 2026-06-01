# Work Breakdown Structure — Kuralle Engagement

> **The build plan, sprint by sprint, end-to-end.** Spans the WhatsApp-engagement RFC rev4 (omnichannel: WhatsApp · Web · Instagram) plus its PRD, CONCEPT, and RESEARCH grounding. Every sprint is an end-to-end demoable slice, not a horizontal slab. Cadence and engineering practice are the same across all sprints.

---

## 1. Cadence and engineering practice

### 1.1 Cadence
- **1w sprints.** Planning at session start; implementation (Phase A) then sprint-level review (Phase B) within the session; warm-down at the end.
- **One sprint goal**, expressed as a single sentence with a verifiable outcome.
- **2–5 stories per sprint.** Smaller is better. Each story ships independently.
- **No carry-over.** If a story slips, it goes back to the backlog, not the next sprint as-is. Rewrite the story.

### 1.2 Definition of Done (universal)
A sprint's stories are collectively Done when **all** of the following hold:

1. Every story commits atomically (`[S{N}-{nn}] {title}`) to `main` behind a green CI run on the project's supported runtimes (Bun + Node; `bun run typecheck:all` is the full gate).
2. Unit tests written for every new exported function / class. **Coverage is not the metric**; *behavioral coverage* is — every public surface tested with at least one happy-path and one failure-path test, using the offline fake-client pattern (`packages/kuralle-messaging/test`, `kuralle-messaging-meta/test`, `kuralle-e2e-tests`).
3. **Passes the four-role sprint-level review pipeline:** spec + code-quality gate by `pi`, manager critical r1 review, and (when source/test code shipped) adversarial r2 review by an independent `codex` worker.
4. **Public surfaces match the source RFC.** Diffs to the RFC require an explicit RFC amendment (in `rfcs/whatsapp-engagement/`) in the same sprint.
5. Stream events match the documented taxonomy (`HarnessStreamPart`). New variants are additive only and require a doc note; `typecheck:all` proves exhaustive switches still compile.
6. Docs updated: at minimum the package's README; at most an RFC delta (the repo rule is "docs in the same change").
7. Manual demo artifact captured per story or per sprint (offline fake-client transcript or a runnable example invocation).
8. **No `--no-verify`, no type-suppression, no silent-catch shortcuts.** If you can't meet a check, change the design, not the gate.

### 1.3 Branching and commits
- Trunk-based. Cursor commits per-story atomic implementations directly. Manager commits the fix pass + closeout commits.
- Every commit message includes the story id (or `[S{N}-fix]` / `[S{N}-close]` for manager commits) and a body summarizing the diff. **Monorepo rule: version + publish the whole `@kuralle-agents/*` graph together** — never publish `core` alone (consumers would install two copies).
- Demo artifact links live in the commit body.

### 1.4 The review loop (four roles, sprint-level cadence)

The review pipeline runs **once per sprint**, after every story is committed. Four roles, four workers, four distinct value adds:

1. **Phase A — IC implementation.** `cursor` is fired as a fresh process per story. Writes the diff against the brief, runs build/test, **commits atomically** before exiting. Each story = one fresh cursor invocation = one clean context window.
2. **Phase B begins — Spec + code-quality gate.** `pi` reads every story brief + the entire sprint diff. Verifies acceptance criteria, file-list adherence, wiring, test quality. **Same team as the IC; NOT adversarial.** Output: `sprints/sprint-N/gate-sprint.md` with verdict `green` / `yellow` / `red`.
3. **Manager critical review (r1).** Main session reads the gate report + the diff and writes `sprints/sprint-N/review-sprint-r1.md` using the sandwich method — strengths, critique with severity, constructive close. Manager owns the final diff.
4. **Adversarial second-opinion review (r2).** When the sprint includes source/test code, `codex` reads gate + r1 + diff and writes `sprints/sprint-N/review-sprint-r2.md`. Finds non-obvious bugs (race conditions, type holes, untested paths). Critiques r1 itself if wrong. **Skip rule:** if the sprint has zero source/test changes, r2 is skipped; document in the fix-pass commit body.
5. **Manager fix pass.** Apply every `Apply now` item from gate + r1 + r2. Commit `[S{N}-fix] {description}`. Sprint closes when WARMDOWN + HANDOFF + STATE-update commit lands.

### 1.5 Sprint warm-down (handoff to the next session)
Last hour of every sprint. Two artifacts:

1. `sprints/sprint-N/WARMDOWN.md` — what shipped, what's working, what's not, open issues, decisions made, RFC amendments this sprint.
2. `sprints/sprint-N/HANDOFF.md` — a one-page primer for the next session: read-me-first, current state of the world, sprint N+1 starting state.

The next session reads HANDOFF first, WARMDOWN if it needs depth.

---

## 2. The roadmap

| Sprint | Phase | Goal (one sentence) |
|--------|-------|---------------------|
| 0 | Core seams & scaffold | Scaffold `@kuralle-agents/engagement` and land the additive core seams so a flow run threads a structured `selection` into flow state and `escalate→'human'` pauses (not throws), proven by unit tests. |
| 1 | Window-safe pipeline | Every non-template outbound traverses an `OutboundPipeline` whose non-removable `windowGuard` makes a closed-window free-form send impossible to leak (it defers), proven by a fake-client test. |
| 2 | Smart-send strategist | A closed-window free-form send is converted to an APPROVED template by an injectable strategist (mock selector) behind deterministic guardrails, or deferred — with an audit record per conversion. |
| 3 | Interactive fidelity | A `collect`/`decide` renders WhatsApp buttons/list and inbound button/list/`nfm_reply` routes the flow by stable id (label-independent), with free-text NLU fallback. |
| 4 | Handoff & consent | A human-owned conversation suppresses the bot on inbound and resumes on release; un-opted-in/STOP customers are never messaged. |
| 5 | Proactive outbound | A broadcast template is idempotent across retry and a reply hands into a flow; a drip stops on reply; re-engagement reopens the window and resumes the flow. |
| 6 | Channel adapters | The same bot runs on WhatsApp and Instagram via injected `ChannelPolicy` adapters (web already from Sprint 0), each rendering/recovering per its channel rules. |
| 7 | Integration, proof & release | The multi-platform example demonstrates one bot answering on WhatsApp + Web + Instagram, window-safe, with the full §9 test matrix green and a publish-together dry-run clean. |

The phases above map to the source RFC as follows:

- **Sprint 0** → RFC §8 Phase **A0** (A0.1 inbound types + identity, A0.2 `RunOptions.selection`, A0.3 `WindowStore`, A0.4 `ChannelPolicy` + web policy, A0.5 terminal handoff) + §4.8–4.12.
- **Sprint 1** → RFC §8 Phase **A** (A1 OutboundSink + capability, A2 OutboundPipeline, A3 windowGuard + wire + close bypasses) + §4.1/§4.2 + §6.1 + REQ-1/2/16/17.
- **Sprint 2** → RFC §8 Phase **B** (B1 strategist, B2 selector + catalog, B3 middleware + `smartSend` node) + §4.4 + §6.2 + REQ-4/5/6.
- **Sprint 3** → RFC §8 Phase **C** (C1 stream part + choice metadata, C2 renderer + limits, C3 inbound resolver chain + `nfm_reply`, C4 `withChoices`) + §4.3/§4.6 + §6.3/§6.4 + REQ-7/8/9.
- **Sprint 4** → RFC §8 Phase **D** (D1 ownership + inbound gate, D2 consent + STOP) + §4.11/§4.7 + REQ-10/11/21 (terminal-handoff seam from S0).
- **Sprint 5** → RFC §8 Phase **E** (E1 scheduler, E2 broadcast + ledger, E3 drip + re-engagement) + §4.7 + §6.5 + REQ-12/13.
- **Sprint 6** → RFC §8 Phase **G** (G1 WhatsApp policy, G2 Instagram policy) + §4.12 + REQ-22; Q7 IG re-verification gate.
- **Sprint 7** → RFC §8 Phase **F** (F1 `engagement()` wiring, F2 multi-platform example, F3 README + docs) + §9 validation matrix.

---

## 3. Sprint detail

The format below repeats per sprint. Stories use the id pattern `S{N}-{nn}` (e.g. `S0-01`).

### Sprint 0 — Core seams & scaffold

**Goal:** Scaffold `@kuralle-agents/engagement` and land the additive core seams so a flow run threads a structured `selection` into flow state and `escalate→'human'` pauses (not throws), proven by unit tests.

| Story | Description | DoD |
|-------|-------------|------|
| S0-01 | Scaffold `packages/kuralle-engagement` (package.json, tsconfig, ESM-NodeNext, build, empty index) wired into the Bun workspace; `bun run build` + `typecheck:all` green. | Package builds and is importable; no behavior yet; CI green. |
| S0-02 | A0.1 — extend `InboundMessage` with `button?: {payload,text}`, `interactive.formResponse?`, `customerId`; WhatsApp `toInboundMessage` populates them + parses `nfm_reply`; default session resolver returns `sessionId = threadId` (no `whatsapp:whatsapp:` double-prefix), `userId = customerId`. | Unit tests: `nfm_reply`/template-`button` parsed; `session_id_not_double_prefixed`. |
| S0-03 | A0.2 — additive `RunOptions.selection`; runtime merges `selection.formData` into flow state **before the first effect** and exposes `selection.id` as `input`. | Tests `selection_formdata_lands_in_flow_state` + `selection_id_is_routing_input`; durable-replay safe (persisted into `run.state`). |
| S0-04 | A0.3/A0.4 — `WindowStore` interface + `InMemoryWindowStore` (fail-closed on miss); `ChannelPolicy`/`ClosedWindowStrategy` types + `webPolicy()` (no window, no consent). | Tests: `window_store_fail_closed`; `webPolicy` always-open. |
| S0-05 | A0.5 — `Runtime` terminal handoff targets (default `['human']`): a handoff to a terminal target pauses the run + emits a `handoff` part instead of resolving an agent. | Test `escalate_to_human_does_not_throw` (no missing-agent error; run pauses + emits). |

**Demo:** offline fake-client transcript: a trivial flow where a `selection.id`+`formData` reach a `decide`/`collect`, and an `escalate→'human'` pauses-and-emits rather than throwing. Package builds; `typecheck:all` green.

**Dependencies:** none.

**Source RFC §:** §4.8–4.12, §6.3, §8 Phase A0; REQ-19/20/22/23.

**Sprint-specific risks:**
- `RunOptions.selection` durable-replay correctness → persist merged selection into `run.state` *before* the first effect (test resume path).
- Terminal-handoff change touches `Runtime` core → keep additive; `typecheck:all` proves no exhaustive-switch break.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 1 — Window-safe pipeline

**Goal:** Every non-template outbound traverses an `OutboundPipeline` whose non-removable `windowGuard` makes a closed-window free-form send impossible to leak (it defers), proven by a fake-client test.

| Story | Description | DoD |
|-------|-------------|------|
| S1-01 | A1 — `OutboundSink` + channel-neutral `OutboundTemplate` + capability detection `isTemplateCapable`; `WhatsAppClient` satisfies `sendTemplate`. | Capability detection unit-tested; no WhatsApp type leaks into `messaging`. |
| S1-02 | A2 — `OutboundMiddleware`/`OutboundRequest`/`SendOutcome`/`WindowState` types + `OutboundPipeline`; constructor asserts a `window-guard` exists **and is terminal**. | Tests: pipeline composes; `window_guard_required` (+ terminal) throws if absent/misordered. |
| S1-03 | A3 — `windowGuard` gates ALL non-template payloads (text/media/interactive) reading `WindowStore`; wire `StreamMapper`→pipeline in `createMessagingRouter`; **close both bypasses** (router `fallbackMessage`; custom `responseMapper` reshaped to emit `OutboundPayload`s; deprecate/wrap `sendTextOrTemplate`). | Tests: `window_closed_blocks_freeform`, `window_closed_blocks_media_and_interactive`, `fallback_and_custom_mapper_route_through_pipeline`. |

**Demo:** fake-client transcript — window closed ⇒ a `reply`/media/interactive send produces zero client free-form calls (outcome `deferred`); window open ⇒ it sends. Messenger/web paths in the example unaffected.

**Dependencies:** Sprint 0.

**Source RFC §:** §4.1/§4.2, §6.1, §8 Phase A; REQ-1/2/16/17.

**Sprint-specific risks:**
- In-memory `WindowStore` won't share across processes → fail-closed default + durable adapter deferred (backlog); test the fail-closed path.
- Reshaping the `responseMapper` contract is a public-surface change → land with a doc note; verify Messenger/web example still builds.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 2 — Smart-send strategist

**Goal:** A closed-window free-form send is converted to an APPROVED template by an injectable strategist (mock selector) behind deterministic guardrails, or deferred — with an audit record per conversion.

| Story | Description | DoD |
|-------|-------------|------|
| S2-01 | B1 — `SmartSendStrategist` + guardrails (`catalog.approved()` filter → `validateParams` → audit → else defer); window-open ⇒ `freeform` with no selector call. | Tests: `strategist_filters_paused_templates`, `strategist_defers_on_bad_params`, `strategist_audits_conversion`, `window_open_no_selector_call`. |
| S2-02 | B2 — `TemplateSelector` seam (injectable/mockable AI); `TemplateCatalog` over the WhatsApp templates API filtering APPROVED + non-paused; extend `TemplateInfo` with quality/paused; component-aware `OutboundTemplate`. | Mock selector in tests; catalog filter unit-tested. |
| S2-03 | B3 — `strategistMiddleware` (the windowGuard hands off to it) + `smartSend` action node sharing the same strategist instance. | Test: node↔guard parity (same decision for same input). |

**Demo:** closed-window text → mock selector picks `cart_reminder` → `converted` + audit row; paused template excluded; bad params → `defer`.

**Dependencies:** Sprint 1.

**Source RFC §:** §4.4, §6.2, §8 Phase B; REQ-4/5/6.

**Sprint-specific risks:**
- Strategist on the hot path → window-open short-circuit (no AI call), `catalog.approved()` cached, selector timeout → `defer`.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 3 — Interactive fidelity

**Goal:** A `collect`/`decide` renders WhatsApp buttons/list and inbound button/list/`nfm_reply` routes the flow by stable id (label-independent), with free-text NLU fallback.

| Story | Description | DoD |
|-------|-------------|------|
| S3-01 | C1 — additive `{type:'interactive'}` `HarnessStreamPart`; optional `choices` metadata on `collect`/`decide`; emit on node entry. | `typecheck:all` proves additive (no exhaustive-switch break); documents which `HarnessStreamPart` union is authoritative. |
| S3-02 | C2 — `interactiveRenderer` middleware: `ChoiceOption[]` → buttons(≤3)/list(≤10)/cta/Flows; **validate limits in the renderer (explicit error, no silent slice).** | Tests: `render_picks_buttons_then_list`, `renderer_rejects_over_limit`. |
| S3-03 | C3 — `InboundResolverChain` (`InteractiveResolver` then `TextResolver`) replacing the text-only `input` derivation; map button/list/template-`button`/`nfm_reply` → id/formData. | Tests: `interactive_routes_by_id_not_label`, `template_button_payload_routes`, `nfm_reply_form_in_state`, `free_text_nlu_fallback`. |
| S3-04 | C4 — `withChoices` author helper; `selection` threaded via Sprint-0 `RunOptions.selection`. | Author can attach choices to a `collect`/`decide`; end-to-end fake-client demo. |

**Demo:** fake-client — a `decide` renders 3 buttons; tapping routes on `id` regardless of label; 6 options render a list; a Flow submission lands `formData` in flow state.

**Dependencies:** Sprint 0 (selection), Sprint 1 (pipeline).

**Source RFC §:** §4.3/§4.6, §6.3/§6.4, §8 Phase C; REQ-7/8/9.

**Sprint-specific risks:**
- Two `HarnessStreamPart` unions (`types/stream.ts` + `types/voice.ts`) → add the variant to the text/stream union; document authoritative contract; `typecheck:all` gate.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 4 — Handoff & consent

**Goal:** A human-owned conversation suppresses the bot on inbound and resumes on release; un-opted-in/STOP customers are never messaged.

| Story | Description | DoD |
|-------|-------------|------|
| S4-01 | D1 — `OwnershipStore` (SessionStore-backed); `escalate→'human'` becomes `ownership.claim` via the Sprint-0 terminal-handoff seam; **inbound** ownership gate suppresses `runtime.run` while owned; release resumes. | Tests: `human_owned_inbound_does_not_run_flow`, resume-on-release. |
| S4-02 | D2 — `ConsentStore` (customer-keyed); `STOP` handler opts out; `consentGate` middleware blocks outbound for un-opted-in / opted-out. | Tests: `not_opted_in_blocks_send`, `stop_opts_out_and_halts_drip`. |

**Demo:** human claims a chat → subsequent inbound recorded, bot silent; release → flow resumes. `STOP` → no further sends.

**Dependencies:** Sprint 0 (terminal handoff), Sprint 1 (pipeline/gates).

**Source RFC §:** §4.7/§4.11, §8 Phase D; REQ-10/11/21.

**Sprint-specific risks:**
- Ownership state must be read on the inbound path before `runtime.run` (outbound suppression alone is insufficient) → gate in `createMessagingRouter.onInbound`.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 5 — Proactive outbound

**Goal:** A broadcast template is idempotent across retry and a reply hands into a flow; a drip stops on reply; re-engagement reopens the window and resumes the flow.

| Story | Description | DoD |
|-------|-------------|------|
| S5-01 | E1 — `Scheduler` interface + default in-process impl; documented production adapters (BullMQ/Cloud Tasks/cron). | Scheduler enqueue/cancel unit-tested. |
| S5-02 | E2 — broadcast engine sending approved templates **through the pipeline**; `BroadcastLedger` (`putIfAbsent`, atomic) keyed by `(campaign,customer)`; reply enters a flow via the normal router. | Tests: `broadcast_ledger_idempotent_per_campaign_recipient`, `broadcast_reply_enters_flow`. |
| S5-03 | E3 — drip/sequence with per-step delay + stop-on-reply; re-engagement template reopens the window and resumes the flow. | Tests: `drip_stops_on_reply`, `reengagement_reopens_window_and_resumes`. |

**Demo:** a broadcast run is a no-op on retry (ledger); a recipient reply enters the reorder flow; a drip halts when the customer replies.

**Dependencies:** Sprint 2 (templates), Sprint 4 (consent).

**Source RFC §:** §4.7, §6.5, §8 Phase E; REQ-12/13.

**Sprint-specific risks:**
- Broadcast idempotency cannot rely on the per-run effect log (`runId == sessionId`) → explicit `BroadcastLedger` with atomic `putIfAbsent`; test the retry path.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 6 — Channel adapters

**Goal:** The same bot runs on WhatsApp and Instagram via injected `ChannelPolicy` adapters (web already from Sprint 0), each rendering/recovering per its channel rules.

| Story | Description | DoD |
|-------|-------------|------|
| S6-01 | G1 — `whatsappPolicy({client,selector})`: window via `WindowStore`; `closedWindow:{kind:'template',strategist}`; renderer → buttons/list/cta/Flows; inbound → button/list/template-button/`nfm_reply`. | Test: WhatsApp policy reproduces all Sprint 1–3 behaviors (no regression of the WA path). |
| S6-02 | **Q7 gate** — re-verify Instagram specifics against current Meta Instagram Platform docs (24h window, `HUMAN_AGENT` tag duration, quick-reply/carousel caps) before building G2. | A short verified note in RESEARCH §6; flag for `/grill-me` if Meta diverges from the RFC assumption. |
| S6-03 | G2 — `instagramPolicy({client})`: 24h window; `closedWindow:{kind:'message-tag',tag:'HUMAN_AGENT'}` (**text only**; interactive/media defer); renderer → `sendButtonTemplate`/`sendQuickReplies`(≤13)/`sendGenericTemplate`; inbound quick-reply/postback → id. | Tests: `instagram_closed_window_tags_or_defers`; same flow runs on WA + IG. |

**Demo:** the same flow answers on WhatsApp (buttons/Flows) and Instagram (quick-replies/carousel); closed-window IG text tagged, interactive deferred.

**Dependencies:** Sprints 1–5.

**Source RFC §:** §4.12, §8 Phase G; REQ-22; RESEARCH §6 / Q7.

**Sprint-specific risks:**
- IG specifics unverified vs Meta docs → **S6-02 is a hard gate before S6-03**; the real IG client (`messaging-meta/src/instagram`) supports the assumed primitives but tags wrap text only.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 7 — Integration, proof & release

**Goal:** The multi-platform example demonstrates one bot answering on WhatsApp + Web + Instagram, window-safe, with the full §9 test matrix green and a publish-together dry-run clean.

| Story | Description | DoD |
|-------|-------------|------|
| S7-01 | F1 — `engagement({ policies: [...] })` channel-agnostic wiring; `.bridge` spreads into `createMessagingRouter`; `.broadcasts` export. | Wiring unit-tested; one bot, N policies. |
| S7-02 | F2 — extend `packages/kuralle-messaging-meta/examples/multi-platform` to demonstrate the SAME bot on WhatsApp + web + Instagram: window-safety, buttons/list routing by id, handoff ownership, a broadcast-to-flow (WhatsApp). | `same_bot_across_channels` E2E (fake-client); example builds + runs. |
| S7-03 | F3 — package README + a docs guide page; full `bun run typecheck:all` + the §9 test matrix green; **publish-together dry-run** (`pnpm publish -r --dry-run`) clean across the changed `@kuralle-agents/*` graph. | Docs in the same change; release dry-run shows no split-graph pin. |

**Demo:** the multi-platform example, driven by the offline fake-client, answering identically across WhatsApp + web + Instagram; `typecheck:all` + suite green; publish dry-run clean.

**Dependencies:** Sprints 0–6.

**Source RFC §:** §8 Phase F, §9 Validation; whole-RFC acceptance.

**Sprint-specific risks:**
- Version + publish together → the dry-run must cover every changed package (`core` stream variant, `messaging`, `messaging-meta`, `engagement`) in one release.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared; RFC acceptance criteria (PRD success criteria) all demonstrably met.

---

## 4. Backlog (deferred to v1.x or v2)

| ID | Item | Earliest | Source RFC § |
|----|------|----------|--------------|
| BK-01 | CRM / contacts / attributes / segments management UI | v1.x | PRD Out of Scope; CONCEPT |
| BK-02 | Team-inbox UI (the ownership *gate* ships; the inbox *surface* does not) | v1.x | PRD Out of Scope |
| BK-03 | Analytics / reporting dashboards | v1.x | PRD Out of Scope |
| BK-04 | No-code visual flow builder | v2 | PRD Out of Scope |
| BK-05 | Messenger `ChannelPolicy` adapter (message tags / OTN) | v1.x | RESEARCH §6 (deferred) |
| BK-06 | Durable `WindowStore` adapter (Redis/Postgres) for multi-process | v1.x | RFC §4.9 / REQ-18 |

---

## 5. Risks tracked across sprints

| Risk | Sprint(s) it materializes | Owner | Mitigation |
|------|---------------------------|-------|------------|
| Additive `HarnessStreamPart` variant turns non-additive (breaks exhaustive switches) | 3 | Manager | `typecheck:all` gate; switches have `default` returns; abort to RFC if non-additive (RFC §11). |
| In-memory `WindowStore` diverges/fails across processes | 1, 6 | Manager | Fail-closed default; durable adapter in backlog (BK-06); window read via `WindowStore` only. |
| `RunOptions.selection` not persisted before first effect (replay drift) | 0, 3 | IC/Manager | Persist merged selection into `run.state` at turn start; test resume path. |
| Strategist latency / AI flakiness on the hot path | 2, 5 | Manager | Window-open short-circuit (no AI call); cached `catalog.approved()`; selector timeout → `defer`. |
| `escalate→'human'` throws if terminal-handoff seam not landed first | 0, 4 | Manager | A0.5 (terminal handoff) is a Sprint-0 blocker dependency for Sprint 4 D1. |
| Instagram specifics unverified vs Meta docs (Q7) | 6 | Manager | S6-02 hard verification gate before S6-03; `/grill-me` if Meta diverges. |
| Version + publish split-graph pin breakage | 7 | Manager | Publish the whole changed `@kuralle-agents/*` graph in one release; dry-run gate. |
| Two `HarnessStreamPart` unions drift | 3 | Manager | Add variant to the authoritative text/stream union; document; gate with `typecheck:all`. |

---

## 6. The role of this document

This WBS is the *plan*, not the *prompt*. The prompt that any new session uses to advance the project one sprint lives at [`./SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md). The current sprint pointer lives at [`./STATE.md`](./STATE.md). Templates for the per-sprint artifacts live under [`./templates/`](./templates/).

When this WBS conflicts with the source RFC, **the RFC wins** — amend `rfcs/whatsapp-engagement/` in the same commit.
