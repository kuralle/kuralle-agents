# Sprint 0 — Plan

**Sprint name:** Core seams & scaffold
**Sprint goal (one sentence):** Scaffold `@kuralle-agents/engagement` and land the additive core seams so a flow run threads a structured `selection` into flow state and `escalate→'human'` pauses (not throws), proven by unit tests.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

---

## 0. Decisions made before briefing (read first)

- **Package name & path.** The RFC is internally inconsistent: §4.4/§5.1 (older prose) say `@kuralle-agents/whatsapp-engagement` / `kuralle-whatsapp-engagement`, while **REQ-22 (rev3, the latest revision)** and the WBS both say **`@kuralle-agents/engagement`** at **`packages/kuralle-engagement/`**. The RFC's own latest revision wins; the stale references are an editorial defect, not a divergence. We build `@kuralle-agents/engagement`. This is recorded here, not silently. (No RFC amendment commit needed — we are following REQ-22 as written.)
- **`ResolvedSelection` type ownership (S0-03/S0-04).** `messaging` depends on `core`, never the reverse. The canonical `ResolvedSelection = { id?: string; formData?: Record<string, unknown> }` therefore lives in **`@kuralle-agents/core`** (exported from the public surface); `messaging`'s §4.3 resolver chain (Sprint 3) will import it from core. Defining it twice would split the type. Core owns it.
- **`escalate` already pauses.** `runFlow.ts:162` already does `await ctx.signal('__escalate', …)` (a durable pause) before returning `{ kind:'handoff', to:'human' }`. The bug is purely that `Runtime.ts:178-180` then looks up a `'human'` agent and throws. S0-05 intercepts the terminal target **before** that lookup — it does not change the escalate transition itself.
- **`handoff` stream part already exists.** `stream.ts:12` already has `{ type:'handoff'; targetAgent:string; reason?:string }`. S0-05 emits an existing variant — genuinely additive, no `HarnessStreamPart` change.

---

## 1. Stories

Order is dependency-driven: **S0-01 first** (scaffold — everything else is independent of it but it proves the workspace wiring), then the four core seams (S0-02..S0-05) which are mutually independent and could parallelize, but we run them sequentially with proceed-evidence between each per the loop.

### `S0-01` — Scaffold `packages/kuralle-engagement`

**Description:** Create a new publishable workspace package `@kuralle-agents/engagement` at `packages/kuralle-engagement/` (ESM, `module: NodeNext`), mirroring the `kuralle-messaging` package shape (package.json/tsconfig/scripts). Empty `src/index.ts` (no behavior yet). Wire it into the Bun workspace (`bun install`) and into the topological build (`scripts/build-packages.sh`) so `bun run build` builds it and `bun run typecheck:all` sweeps it.

**Acceptance criteria** (priority order):
1. `packages/kuralle-engagement/package.json` declares `@kuralle-agents/engagement`, `type: module`, `main`/`types` → `dist/`, `exports` map, `build`/`clean`/`test` scripts mirroring `kuralle-messaging`; `dependencies` includes `@kuralle-agents/core: workspace:*` (messaging added in a later sprint, not now).
2. `packages/kuralle-engagement/tsconfig.json` mirrors `kuralle-messaging/tsconfig.json` (NodeNext, strict, `noFallthroughCasesInSwitch`, no source maps).
3. `src/index.ts` exists and is empty/near-empty (a single `export {}` or a doc comment is fine — no runtime behavior).
4. The package is added to a build tier in `scripts/build-packages.sh` **after `core`** (the T3 tier alongside `messaging-meta` is correct — it depends only on `core` now but will depend on `messaging`/`messaging-meta` later; placing it in T3 is race-safe).
5. `cd packages/kuralle-engagement && npm run build` produces `dist/index.js` + `dist/index.d.ts`, no `.map` files.
6. From repo root: `bun install` succeeds (package registered), `bun run build` is green (engagement builds in order), `bun run typecheck:all` is green (sweep picks up the new tsconfig).

**Files created/modified:**
- Create: `packages/kuralle-engagement/package.json`, `packages/kuralle-engagement/tsconfig.json`, `packages/kuralle-engagement/src/index.ts`, `packages/kuralle-engagement/README.md`
- Modify: `scripts/build-packages.sh` (add `engagement` to T3 tier), root `bun.lockb`/lockfile (via `bun install`)

**Demo artifact:** `sprints/sprint-0/artifacts/s0-01-build.txt` — captured output of `bun run build` + `ls packages/kuralle-engagement/dist` + `bun run typecheck:all` tail showing green.

### `S0-02` — A0.1 Inbound types + customer identity (R-04/R-05)

**Description:** Extend `InboundMessage` with `button?: { payload: string; text: string }`, `interactive.formResponse?: Record<string, unknown>`, and `customerId: string`. WhatsApp `toInboundMessage` populates them and parses `nfm_reply.response_json`. The default session resolver returns `sessionId = message.threadId` (NO `${platform}:` prefix — WhatsApp `threadId` is already `whatsapp:{phoneNumberId}:{from}`, so the current resolver double-prefixes to `whatsapp:whatsapp:…`) and `userId = customerId`.

**Acceptance criteria** (priority order):
1. `InteractiveReply` gains optional `formResponse?: Record<string, unknown>`; `InboundMessage` gains `button?: { payload: string; text: string }` and `customerId: string`. All additive (the `customerId` field — see note below).
2. WhatsApp `toInboundMessage` (`client.ts` ~592, ~609-620): populates `button` from the top-level template `button` (payload + text), populates `interactive.formResponse` by JSON-parsing `nfm_reply.response_json` (today dropped), and sets `customerId = msg.from` (wa_id/phone).
3. JSON parse of `response_json` is failure-safe (malformed JSON → `formResponse` undefined, no throw).
4. `defaultSessionResolver` returns `sessionId = message.threadId`, `userId = message.customerId ?? message.from.id`. No double-prefix.
5. Tests: `nfm_reply_and_template_button_parsed` (WA client populates `formResponse` + `button.payload`); `session_id_not_double_prefixed` (resolver yields `whatsapp:{phoneNumberId}:{from}`, not `whatsapp:whatsapp:…`).

**Files created/modified:**
- Modify: `packages/kuralle-messaging/src/types/messages.ts`, `packages/kuralle-messaging/src/adapter/session-resolver.ts`, `packages/kuralle-messaging-meta/src/whatsapp/client.ts`
- Create/modify tests: `packages/kuralle-messaging/test/session-resolver.test.ts` (or extend existing), `packages/kuralle-messaging-meta/test/` (WA client inbound test)

**Note (anti-scope trap):** `customerId: string` is a **required** field on `InboundMessage`. Every existing producer of `InboundMessage` (every platform client's `toInboundMessage`) must set it, or `typecheck:all` breaks. IC must grep `messaging-meta/src` for all `InboundMessage` construction sites (WhatsApp, Messenger, Instagram if present) and set `customerId` on each (use `from.id`/`from` as appropriate). If making it required would cascade beyond the meta clients, **stop and ask** — do not make it optional silently (that would weaken REQ-19). Surfacing this is in-scope.

**Demo artifact:** `sprints/sprint-0/artifacts/s0-02-tests.txt` — `bun test` output for the two named tests passing.

### `S0-03` — A0.2 `RunOptions.selection` propagation (R-03/REQ-20)

**Description:** Add an additive optional `selection?: ResolvedSelection` to core's `RunOptions`. At turn start the runtime merges `selection.formData` into the run's flow state (`runState.state`) **and persists it before the first effect** (durable-replay safe), and exposes `selection.id` as the routing value (`input`). Absent `selection` → behaves exactly as today.

**Acceptance criteria** (priority order):
1. Define & export `ResolvedSelection = { id?: string; formData?: Record<string, unknown> }` from `@kuralle-agents/core` (new `src/types/selection.ts` or co-located; export from `src/index.ts`). This is the canonical type messaging will import later.
2. `RunOptions` (`Runtime.ts:51`) gains `selection?: ResolvedSelection`. `OpenRunOptions` (`openRun.ts`) gains the same; `Runtime.run` threads it into `openRun`.
3. In `openRun`, when `selection.formData` is present, merge it into `runState.state` (shallow merge: `{ ...runState.state, ...selection.formData }`) and persist via `runStore.putRunState` **before** the input is queued / before returning (so a resume replays the same state — the merge must land in `run.state`, not be recomputed each turn). When `selection.id` is present, use it as the effective `input` (it drives `input`/routing) — `selection.id` takes precedence over `opts.input` for the routing string.
4. Durable-replay safe: re-running `openRun` for an already-merged turn does not double-apply or drift (idempotent merge; persisted into `run.state`). Cover the resume path in a test.
5. Tests (core): `selection_formdata_lands_in_flow_state` (formData merged into `runState.state` and visible to a flow node); `selection_id_is_routing_input` (`selection.id` becomes the routing `input`); a resume/replay test proving the merged state persists and is not re-derived.

**Files created/modified:**
- Create: `packages/kuralle-core/src/types/selection.ts` (or add to an existing types file — IC's call, but export from index)
- Modify: `packages/kuralle-core/src/runtime/Runtime.ts`, `packages/kuralle-core/src/runtime/openRun.ts`, `packages/kuralle-core/src/index.ts` (export `ResolvedSelection`); possibly `runtime/ctx.ts` only if needed (prefer not)
- Create test: `packages/kuralle-core/test/` (or wherever core runtime tests live — grep first) `run-options-selection.test.ts`

**Note:** §4.8 says "merge before the first effect." The merge point is `openRun` (turn start, before `runFlow`/`hostLoop` run any effect). Do **not** plumb selection through `ctx.tool`/effect log. Keep the change additive — no signature change to `runFlow`/`hostLoop`.

**Demo artifact:** `sprints/sprint-0/artifacts/s0-03-tests.txt` — passing test output incl. the resume-path test.

### `S0-04` — A0.3/A0.4 `WindowStore` + `ChannelPolicy`/`webPolicy()`

**Description:** Two additive seams. (a) Extract a `WindowStore` interface in `messaging`; ship `InMemoryWindowStore` wrapping the existing `WindowTracker`; an unknown/missing window resolves **fail-closed** to `{ open: false }`. (b) Define `ChannelPolicy` / `ClosedWindowStrategy` types in `engagement` and ship `webPolicy()` — the trivial null adapter (`hasWindow: false`, `consentRequired: false`, `closedWindow: { kind:'none' }`, `isWindowOpen → true`).

**Acceptance criteria** (priority order):
1. `WindowState = { open:true; expiresAt: Date } | { open:false; expiresAt: Date | null }` and `interface WindowStore { get(threadId): Promise<WindowState>; recordInbound(threadId, ts: Date): Promise<void>; recordExpiry(threadId, at: Date): Promise<void> }` in `packages/kuralle-messaging/src/adapter/window-store.ts`.
2. `InMemoryWindowStore` wraps/uses the existing `WindowTracker` semantics. `get()` for an untracked thread returns `{ open: false, expiresAt: null }` (**fail closed** — never `open:true` on a miss). For a tracked, expired thread → `{ open:false, expiresAt }`; for a live thread → `{ open:true, expiresAt }`.
3. Exported from `messaging`'s index. (Do **not** rewire `createMessagingRouter` to use it yet — that is Sprint 1 / A3. S0-04 only introduces the interface + impl and proves fail-closed.)
4. In `engagement`: `interface ChannelPolicy { readonly channel:string; readonly hasWindow:boolean; isWindowOpen(threadId):Promise<boolean>; readonly closedWindow:ClosedWindowStrategy; readonly consentRequired:boolean; renderInteractive(options:ChoiceOption[], prompt:string):InteractiveMessage; resolveInbound(m:InboundMessage):{ input:string; selection?:ResolvedSelection } }` and `type ClosedWindowStrategy = { kind:'template'; strategist: SmartSendStrategist } | { kind:'message-tag'; tag:string } | { kind:'none' }`.
5. `webPolicy(): ChannelPolicy` returns `channel:'web'`, `hasWindow:false`, `isWindowOpen → Promise<true>`, `closedWindow:{kind:'none'}`, `consentRequired:false`, a `renderInteractive` that maps `ChoiceOption[]`→ an `InteractiveMessage` (buttons), and `resolveInbound` returning `{ input: m.text ?? '' }` (web may pass explicit selection later).
6. Tests: `window_store_fail_closed` (untracked thread ⇒ `{open:false}`); `webPolicy` always-open (`isWindowOpen → true`, never gates).

**Type-dependency note:** `ChannelPolicy.closedWindow` references `SmartSendStrategist` (Sprint 2) and `ChoiceOption` (§4.5, Sprint 3) and `InteractiveMessage`/`InboundMessage`/`ResolvedSelection` (messaging+core). For Sprint 0, the `'template'` strategy's `strategist` type and `ChoiceOption` do not yet exist. **Resolution:** define minimal local placeholder types in `engagement` ONLY if the real ones don't exist yet — specifically define `ChoiceOption` now (it is a stable §4.5 author type: `{ id:string; label:string; description?:string; url?:string; flow?:{ flowId:string; cta:string } }`) and define a **forward-declared `SmartSendStrategist`** as `interface SmartSendStrategist { decide(input: unknown): Promise<unknown> }` placeholder with a `// TODO(S2-01): replace with the real strategist interface` marker, OR type `closedWindow` `'template'` variant's strategist as `unknown` with that TODO. Prefer defining `ChoiceOption` properly (it won't change) and a minimal strategist placeholder. Flag in your report which placeholders you introduced so Sprint 2 replaces them. Import `InteractiveMessage`, `InboundMessage` from `@kuralle-agents/messaging` and `ResolvedSelection` from `@kuralle-agents/core` — **this adds `@kuralle-agents/messaging` as a dependency of `engagement`**, so add it to `package.json` (`workspace:*`) and `bun install`.

**Files created/modified:**
- Create: `packages/kuralle-messaging/src/adapter/window-store.ts`, `packages/kuralle-engagement/src/policy.ts`, `packages/kuralle-engagement/src/policies/web.ts`
- Modify: `packages/kuralle-messaging/src/index.ts` (export WindowStore types), `packages/kuralle-engagement/src/index.ts` (export policy + webPolicy), `packages/kuralle-engagement/package.json` (add messaging dep)
- Create tests: `packages/kuralle-messaging/test/window-store.test.ts`, `packages/kuralle-engagement/test/web-policy.test.ts`

**Demo artifact:** `sprints/sprint-0/artifacts/s0-04-tests.txt` — passing tests for fail-closed + web-policy.

### `S0-05` — A0.5 Terminal handoff targets (rev4, R-08-B/REQ-23)

**Description:** `Runtime` gains a configured set of **terminal handoff targets** (default `['human']`). When the host loop returns a handoff whose target is terminal, the runtime **pauses the run and emits a `handoff` stream part** instead of resolving an agent — eliminating the `Runtime.ts:178-180` missing-agent throw on `escalate→'human'`. Non-terminal handoffs behave exactly as today.

**Acceptance criteria** (priority order):
1. `HarnessConfig` (`Runtime.ts:37`) gains additive optional `terminalHandoffTargets?: string[]`; constructor stores it as a `Set<string>` defaulting to `new Set(['human'])`.
2. In `Runtime.run`, inside the `if (loopResult.kind === 'handoff')` block, **before** `this.agentsById.get(loopResult.to)`: if `loopResult.to` is a terminal target → emit `{ type:'handoff', targetAgent: loopResult.to, reason: loopResult.reason }`, set `runCtx.runState.status = 'paused'`, persist (`runStore.putRunState`), and `break` out of the loop (do NOT increment handoffCount, do NOT resolve an agent, do NOT throw). The `finally` block's `closeRun`/`done` emit still runs.
3. Non-terminal handoff → unchanged (resolve agent, switch, continue).
4. Avoid a double `handoff` emit: the escalate path (`runFlow.ts:161-163`) does **not** emit a handoff part, so the Runtime emit is the only one for escalate. The explicit `{ handoff:'x' }` transition path (`runFlow.ts:157`) and `hostLoop` already emit before returning — if `x` is terminal, that would double-emit. Document this in your report; if a clean dedupe is cheap (e.g., Runtime emits only when the target is terminal AND wasn't already emitted) note it, but the required test targets `escalate` only and a duplicate informational stream part is benign. Do not refactor the existing emit sites (out of scope).
5. Test `escalate_to_human_does_not_throw`: a flow that `escalate`s to `'human'`, on resume (after the `__escalate` signal is delivered) does NOT throw a missing-agent error; the run pauses (`status === 'paused'`) and a `handoff` stream part with `targetAgent:'human'` is emitted. Use the offline pattern (a `decide`/`action` node returning `{ escalate: 'human' }` or `{ handoff: 'human' }`; a fake model is not needed if you drive a flow `action` node).

**Files created/modified:**
- Modify: `packages/kuralle-core/src/runtime/Runtime.ts`
- Create test: `packages/kuralle-core/test/terminal-handoff.test.ts`

**Note:** Keep additive. `typecheck:all` must prove no exhaustive-switch break (there is none — `handoff` part already exists). Do not touch `hostLoop`/`runFlow` emit sites.

**Demo artifact:** `sprints/sprint-0/artifacts/s0-05-tests.txt` — passing `escalate_to_human_does_not_throw`.

---

## 2. Universal DoD checklist (per story)

Adapted from the template (this project's gates differ from the boilerplate RFC-002/wiki references):

- [ ] All acceptance criteria met.
- [ ] Unit tests for every new exported function / class — ≥1 happy-path + ≥1 failure-path, offline fake-client style (`messaging/test`, `messaging-meta/test`, `core/test`).
- [ ] `bun run build` green (topological); the changed package(s) rebuilt (stale-dist gotcha).
- [ ] `bun run typecheck:all` green (full gate — tsconfig sweep + playground + lint).
- [ ] Public TS surfaces match the RFC §4 signatures (this sprint: §4.8 `RunOptions.selection`, §4.9 `WindowStore`, §4.10 inbound types, §4.11 identity, §4.12 `ChannelPolicy`, REQ-23 terminal handoff). Any surface change beyond these → stop and ask.
- [ ] `HarnessStreamPart` unchanged (S0-05 emits the existing `handoff` variant).
- [ ] Package README touched if user-visible (S0-01 README; engagement README notes the policy seam).
- [ ] No `--no-verify`, no `@ts-ignore`/type-suppression, no silent-catch.
- [ ] Atomic commit `[S0-{nn}] {title}` on `plan/whatsapp-engagement`. `.handoff/proof-s0-{nn}.json` written.

---

## 3. Test plan

| Story | Layer | Test type | Named fail-to-pass tests |
|-------|-------|-----------|--------------------------|
| S0-01 | build | smoke | (build + typecheck:all green; no unit test — pure scaffold) |
| S0-02 | unit | happy + failure | `nfm_reply_and_template_button_parsed`, `session_id_not_double_prefixed` |
| S0-03 | unit | happy + failure + replay | `selection_formdata_lands_in_flow_state`, `selection_id_is_routing_input`, resume-persists test |
| S0-04 | unit | happy + failure | `window_store_fail_closed`, `web_null_policy_always_open` |
| S0-05 | unit | happy (no-throw) | `escalate_to_human_does_not_throw` |

**What we will NOT test this sprint, and why it's safe:**
- The full outbound pipeline / windowGuard wiring — that is Sprint 1 (A1–A3). S0-04 only introduces `WindowStore` + `webPolicy`; it does not wire the router. Safe because nothing depends on the wiring yet.
- The strategist behind `ClosedWindowStrategy{kind:'template'}` — Sprint 2. S0-04 uses a forward-declared placeholder. Safe because no policy with `kind:'template'` is constructed in Sprint 0.
- Live Meta API — all offline fake-client.

---

## 4. Demo plan

**Demo (sprint-level):** An offline transcript / test run showing (1) the `engagement` package builds and `typecheck:all` is green; (2) a `RunOptions.selection` with `{ id, formData }` reaches a flow `decide`/`collect` (formData in `runState.state`, id as routing input); (3) an `escalate→'human'` flow pauses and emits a `handoff` part rather than throwing. Captured as the per-story `artifacts/s0-0N-*.txt` files plus a short `artifacts/s0-demo.md` stitching them together at warm-down.

---

## 5. Risks specific to this sprint

| Risk | Detection signal | Mitigation |
|------|------------------|------------|
| `customerId` required field cascades to many `toInboundMessage` sites | `typecheck:all` errors in `messaging-meta` clients | S0-02 brief instructs grepping all construction sites; if it cascades beyond meta clients, IC stops and asks (do not weaken to optional). |
| `selection` merge not persisted before first effect → replay drift | resume test shows state re-derived/doubled | S0-03 merges into `runState.state` in `openRun` + persists; explicit resume-path test (Risk row in WBS §5). |
| `ChannelPolicy` references types that don't exist until S2/S3 (`SmartSendStrategist`, `ChoiceOption`) | `engagement` won't compile | S0-04 defines `ChoiceOption` (stable) + a marked placeholder `SmartSendStrategist`; flagged for Sprint 2 replacement. |
| Terminal handoff double-emits a `handoff` part for explicit `{handoff:'human'}` | two `handoff` parts in stream | S0-05 documents it; benign (informational, idempotent); test targets `escalate` path which emits once. |
| New package not in `build-packages.sh` tiers → `bun run build` skips it / races | engagement `dist` missing after build | S0-01 adds it to the T3 tier explicitly. |

---

## 6. Open questions

- None blocking. The package-name and `ResolvedSelection`-ownership questions are resolved in §0 above with rationale. If an IC finds the `customerId`-required change cascades outside `messaging-meta` (e.g. into `messaging` adapter internals or another package's `InboundMessage` producers), that is the one place to **stop and ask** before proceeding.
