# Sprint 3 — Plan

**Sprint name:** Interactive fidelity
**Sprint goal (one sentence):** A `collect`/`decide` renders WhatsApp buttons/list and inbound button/list/`nfm_reply` routes the flow by stable id (label-independent), with free-text NLU fallback.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

---

## 0. Decisions made before briefing (read first)

- **Two `HarnessStreamPart` unions exist** — `core/src/types/stream.ts` (the **authoritative** text/runtime union; `runFlow.ctx.emit` uses its shapes — `text-delta`/`node-enter`/`handoff`/…) and `core/src/types/voice.ts:264` (a separate voice/realtime union). **The new `{type:'interactive'}` variant goes in `stream.ts` only** (RFC §4.6). Document in the variant's doc-comment that `stream.ts` is authoritative for runtime emit. The additive-ness is the tracked Sprint-3 risk → S3-01 must prove `typecheck:all` stays green (no exhaustive-switch break) and that the two unions' intentional divergence is noted, not accidental. If adding the variant forces a non-additive change, **abort to RFC §11** and flag.
- **`ChoiceOption` relocates to `@kuralle-agents/core`** (the S0-04 forward trap). Core's new stream variant references `ChoiceOption[]`, and core cannot import engagement. Define `ChoiceOption` in core (alongside `ResolvedSelection`, e.g. `core/src/types/selection.ts` or a new `interactive.ts`), export it, and have `engagement/src/policy.ts` + `policies/web.ts` import it from core (re-export from engagement for authors). This is a move, not a new shape — keep the §4.5 fields identical.
- **The interactive payload is free-form and traverses the window-safe pipeline.** A rendered `{kind:'interactive'}` `OutboundPayload` still passes through the S1 `windowGuard` (deferred on a closed window). The `interactiveRenderer` is an `OutboundMiddleware` installed before the terminal `windowGuard` (like `strategistMiddleware`) — it consumes the `{type:'interactive'}` stream part from `req.meta.parts` and rewrites the payload to `{kind:'interactive', interactive}`.
- **Node-entry emit point:** `runFlow.ts:142` emits `node-enter`. Immediately after, if the entered node is a `collect`/`decide` carrying `choices` metadata, emit `{type:'interactive', nodeId, options, prompt}`. Additive emit only — no node-execution change.
- **Inbound resolution reuses S0-02 + S0-03.** `toInboundMessage` already populates `interactive.id` / `button.payload` / `interactive.formResponse` (S0-02). The `InteractiveResolver` reads those → `{input, selection}`; the router calls `runtime.run({input, selection})` (S0-03 merges `selection.formData` into flow state, exposes `selection.id` as `input`). Routing is by stable **id**, label-independent. `TextResolver` is the catch-all (free text → NLU as today).
- **Renderer rejects over-limit (R-11)** — buttons ≤3, list ≤10 rows, label-length caps → **throw an explicit error**, never silently slice (the WhatsApp client silently slices at `client.ts:340`).

---

## 1. Stories

Order: **S3-01 → S3-02 → S3-03 → S3-04** (stream variant + ChoiceOption relocation first; renderer; inbound resolver; author helper + e2e).

### `S3-01` — C1: interactive stream part + choice metadata + ChoiceOption relocation
**Description:** Add the additive `{type:'interactive'; nodeId; options: ChoiceOption[]; prompt}` to `core/src/types/stream.ts`. Relocate `ChoiceOption` to core. Add optional `choices?: ChoiceOption[]` metadata to `CollectNode`/`DecideNode` (`core/src/types/flow.ts`) and emit the interactive part on node entry (`runFlow.ts`, after `node-enter`) when present.
**Acceptance criteria:**
1. `HarnessStreamPart` (stream.ts) gains the `interactive` variant; doc-comment notes stream.ts is authoritative vs voice.ts.
2. `ChoiceOption` defined+exported from core; `engagement/src/{policy,policies/web}.ts` import it from core (re-export from engagement). No shape change.
3. `CollectNode`/`DecideNode` gain optional `choices?: ChoiceOption[]` (additive — `collect()`/`decide()` factories unchanged for callers who omit it).
4. `runFlow` emits `{type:'interactive', nodeId, options, prompt}` on entry to a collect/decide that has `choices` (prompt derived from the node's instructions/first reply text — keep simple; document the source).
5. **Additive proof:** `typecheck:all` green (exhaustive switches over `HarnessStreamPart` still compile — they have `default`s or are non-exhaustive); a test asserts an existing consumer ignores the unknown variant.
6. Tests: `interactive_part_is_additive` (typecheck/consumer), `interactive_emitted_on_node_entry`.
**Files:** `core/src/types/{stream.ts, flow.ts, selection.ts or interactive.ts}`, `core/src/flow/runFlow.ts`, `core/src/index.ts`, `engagement/src/{policy.ts, policies/web.ts, index.ts}`; tests in `core/test/core-flow/`.

### `S3-02` — C2: interactiveRenderer middleware + limits (R-11)
**Description:** `interactiveRenderer(policy?)` `OutboundMiddleware` (engagement) that, when `req.meta.parts` contains a `{type:'interactive'}` part, renders `ChoiceOption[]` → buttons(≤3)/list(≤10)/cta(url)/Flow and rewrites the payload to `{kind:'interactive', interactive}`. **Validates limits in the renderer** — over-limit (>3 buttons, >10 rows, over-length labels) throws an explicit error; no silent slice.
**Acceptance criteria:**
1. `interactiveRenderer` returns an `OutboundMiddleware` (name e.g. `'interactive-renderer'`) installed before the terminal `windowGuard`.
2. ≤3 options ⇒ buttons; 4..10 ⇒ list; an option with `url` ⇒ cta; with `flow` ⇒ Flow. `>10` rows or `>3` buttons or over-length label ⇒ **throws** (explicit error).
3. If no interactive part present ⇒ pass through (`next(req)`).
4. Tests: `render_picks_buttons_then_list` (3⇒buttons, 6⇒list), `renderer_rejects_over_limit` (>3 buttons / >10 rows / over-length → throws).
**Files:** `engagement/src/interactive-renderer.ts`, `engagement/src/index.ts`; uses `webPolicy.renderInteractive` or a WhatsApp renderer (keep channel-neutral via the part → `InteractiveMessage`); tests in `engagement/test/`.

### `S3-03` — C3: InboundResolverChain + InteractiveResolver + TextResolver + nfm_reply
**Description:** `InboundResolverChain` (`messaging`) — `[InteractiveResolver, TextResolver]`, first-match-wins. `InteractiveResolver` maps `m.interactive.id`/`m.button.payload`→`{id}`, `m.interactive.formResponse`→`{formData}`; `TextResolver` returns `m.text`. Replace the `createMessagingRouter.ts` `input = message.text ?? '[type]'` derivation; the router calls `runtime.run({input, selection})`. `MessagingRouterConfig.inputResolver?`.
**Acceptance criteria:**
1. `InboundResolverChain` + `InteractiveResolver` + `TextResolver` in `messaging/src/adapter/input-resolver-chain.ts`; default chain `[InteractiveResolver, TextResolver]`; empty chain throws; no-match throws (TextResolver is catch-all).
2. `createMessagingRouter` uses the chain (default or `config.inputResolver`) and passes `selection` into `runtime.run`.
3. Tests: `interactive_routes_by_id_not_label` (button_reply `{id:'x', title:'A'}` and `{id:'x', title:'totally different'}` → identical transition), `template_button_payload_routes`, `nfm_reply_form_in_state`, `free_text_nlu_fallback`.
**Files:** `messaging/src/adapter/input-resolver-chain.ts`, `createMessagingRouter.ts`, `types/adapter.ts` (`inputResolver?`), `messaging/src/index.ts`; tests in `messaging/test/`.

### `S3-04` — C4: withChoices author helper + e2e
**Description:** `withChoices<N extends CollectNode|DecideNode>(node, options): N` (engagement) attaches `choices` metadata; `selection` threaded via S0-03 `RunOptions.selection`. End-to-end fake-client demo: a `decide` renders 3 buttons; tapping routes on `id` regardless of label; 6 options render a list; a Flow submission lands `formData` in flow state.
**Acceptance criteria:**
1. `withChoices(node, options)` returns the node with `choices` set (typed to `CollectNode|DecideNode`).
2. End-to-end fake-client test stitching S3-01..03: choices emit → renderer → buttons; inbound id routes; Flow → formData in state.
3. Tests: `withchoices_attaches`, `interactive_end_to_end`.
**Files:** `engagement/src/authoring.ts`, `engagement/src/index.ts`; tests in `engagement/test/`.

---

## 2. Universal DoD (per story)
Tests happy+failure offline; `bun run build` + `typecheck:all` green; **`HarnessStreamPart` change is additive** (prove it — S3-01); surfaces match RFC §4.3/§4.5/§4.6; no `--no-verify`/suppression/silent-catch; atomic `[S3-{nn}]` commit + proof JSON; **commit the demo artifact** (proof claim `file:demo_committed` via `git ls-files`); no root `*-implementation-notes.md`. Proof-schema cheat-sheet in every brief.

## 3. Test plan
| Story | Named tests |
|-------|-------------|
| S3-01 | `interactive_part_is_additive`, `interactive_emitted_on_node_entry` |
| S3-02 | `render_picks_buttons_then_list`, `renderer_rejects_over_limit` |
| S3-03 | `interactive_routes_by_id_not_label`, `template_button_payload_routes`, `nfm_reply_form_in_state`, `free_text_nlu_fallback` |
| S3-04 | `withchoices_attaches`, `interactive_end_to_end` |

**Not tested (safe):** live WhatsApp interactive send (offline fake-client); voice `HarnessStreamPart` union (untouched — variant only in stream.ts); Instagram rendering (Sprint 6).

## 4. Demo plan
Fake-client: a `decide` renders 3 buttons; tapping routes on `id` regardless of label; 6 options render a list; a Flow submission lands `formData` in flow state.

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| Additive `HarnessStreamPart` variant turns non-additive (breaks exhaustive switches) | `typecheck:all` fails on a switch | switches have `default`; prove additive in S3-01; abort to RFC §11 if not. |
| Two `HarnessStreamPart` unions drift | a consumer expects the variant in voice.ts | add only to stream.ts (authoritative); document; gate `typecheck:all`. |
| `ChoiceOption` relocation breaks engagement importers | build fails in engagement | move to core + re-export from engagement; update both importers (policy.ts, web.ts). |
| Renderer silently slices over-limit | a 4th button silently dropped | renderer throws explicit error; test `renderer_rejects_over_limit`. |
| Inbound resolver replaces a load-bearing derivation | existing router tests break | TextResolver is catch-all (preserves text path); run full messaging suite. |

## 6. Open questions
None blocking. If the `interactive` stream part's `prompt` source is ambiguous (collect/decide have different instruction shapes), the IC picks the node's reply/instruction text and documents it; flag only if neither node type exposes a usable prompt string.
