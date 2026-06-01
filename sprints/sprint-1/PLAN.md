# Sprint 1 — Plan

**Sprint name:** Window-safe pipeline
**Sprint goal (one sentence):** Every non-template outbound traverses an `OutboundPipeline` whose non-removable `windowGuard` makes a closed-window free-form send impossible to leak (it defers), proven by a fake-client test.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

---

## 0. Decisions made before briefing (read first)

- **No `ChannelPolicy` or strategist in Sprint 1.** The WhatsApp `ChannelPolicy` is Sprint 6 (G1); the smart-send strategist is Sprint 2 (B). So this sprint's `windowGuard` does **not** convert a closed-window send to a template and does **not** call a policy — it **defers**. A closed window ⇒ `SendOutcome { kind:'deferred' }`. (RFC §6.1's `policy.isWindowOpen`/strategist branches arrive in Sprints 2/6; Sprint 1 is the pure leak-block.)
- **`windowGuard` reads the window via `OutboundMeta.window` (the value type from S0-04 `window-store.ts`).** The pipeline driver (the `StreamMapper`/router) reads `WindowStore.get(threadId)` once per send and populates `req.meta.window`; the guard's decision is `req.meta.window.open`. This keeps the guard a pure, unit-testable function while the *system* reads `WindowStore` (WBS "reading WindowStore"). `WindowStore` already fails closed on a miss (S0-04), so a cold store ⇒ `{open:false}` ⇒ guard defers — fail-closed propagates. The non-removable+terminal pipeline assertion (S1-02) guarantees the guard always runs and nothing runs after it, so the only caller (the trusted `StreamMapper`) cannot route a free-form payload around it.
- **Default chain = `[windowGuard]`.** `consentGate`/`ownershipGate` are engagement middleware (Sprint 4) added later via `engagement().bridge`. Sprint 1 installs only the non-removable `windowGuard` + the sink.
- **`OutboundSink` ≈ `PlatformClient`.** `PlatformClient` already has `sendText`/`sendInteractive`/`sendMedia` with the exact `SendResult` signatures; `OutboundSink` is that minimal surface + optional `sendTemplate?`. The platform client IS the sink. No adapter.
- **`OutboundTemplate` is channel-neutral and minimal this sprint** — `{ name; language; namedParams?; positionalParams?; raw? }`. The `components?: TemplateComponent[]` enrichment (R-10, "component-aware") is **Sprint 2 (B2)**, added additively when templates actually flow. Sprint 1 never produces a template payload (guard defers), so the sink's `template` branch is wired but unexercised — documented forward trap.
- **`WhatsAppClient` "satisfies sendTemplate"** = `isTemplateCapable` returns true because the method exists (runtime `typeof` guard). Reconciling the WhatsApp `sendTemplate(to, TemplateMessage)` signature with the neutral `OutboundTemplate` is **Sprint 2 (B2)**; not needed here because no template is sent.

---

## 1. Stories

Dependency order: **S1-01 → S1-02 → S1-03** (types → pipeline → guard+wiring). Sequential with proceed-evidence between each.

### `S1-01` — A1: OutboundSink + OutboundTemplate + capability detection

**Description:** Add the channel-neutral outbound capability surface to `@kuralle-agents/messaging`: `OutboundSink`, `OutboundTemplate`, and `isTemplateCapable`. No WhatsApp type leaks into `messaging` (dependency direction forbids it). `WhatsAppClient` already exposes `sendTemplate`, so capability detection returns true for it.

**Acceptance criteria** (priority order):
1. `OutboundSink` in `messaging/src/types/outbound.ts`: `{ sendText(to:string, text:string): Promise<SendResult>; sendInteractive(to:string, msg:InteractiveMessage): Promise<SendResult>; sendMedia(to:string, media:MediaPayload): Promise<SendResult>; sendTemplate?(to:string, t:OutboundTemplate): Promise<SendResult> }`.
2. `OutboundTemplate` (channel-neutral): `{ name:string; language:string; namedParams?:Record<string,string>; positionalParams?:string[]; raw?:unknown }`.
3. `isTemplateCapable(c: PlatformClient): c is PlatformClient & Required<Pick<OutboundSink,'sendTemplate'>>` — a runtime `typeof (c as { sendTemplate?: unknown }).sendTemplate === 'function'` guard.
4. Exported from `messaging`'s index. `PlatformClient` (in `types/client.ts`) structurally satisfies `OutboundSink` (minus optional `sendTemplate`) — verify by a type-level assignment in the test (no code change to `PlatformClient` required).
5. **No WhatsApp type leak:** `messaging/src` imports nothing from `@kuralle-agents/messaging-meta`. (It can't — wrong dep direction; assert by a grep in proof.)
6. Tests: `isTemplateCapable` returns true for a mock client with `sendTemplate`, false for one without (`capability_detection`).

**Files:** create `packages/kuralle-messaging/src/types/outbound.ts`; modify `packages/kuralle-messaging/src/index.ts`; create `packages/kuralle-messaging/test/outbound-sink.test.ts`.

**Demo artifact:** `sprints/sprint-1/artifacts/s1-01-tests.txt`.

### `S1-02` — A2: OutboundPipeline + middleware contract

**Description:** Add the middleware/pipeline types and the `OutboundPipeline` class. The constructor enforces the non-removable safety invariant: a middleware named `window-guard` must be present **and terminal** (the last middleware before the sink).

**Acceptance criteria** (priority order):
1. In `messaging/src/types/outbound.ts` add: `OutboundNext = (req: OutboundRequest) => Promise<SendOutcome>`; `OutboundMiddleware { readonly name:string; send(req:OutboundRequest, next:OutboundNext): Promise<SendOutcome> }`; `OutboundPayload = {kind:'text';text:string} | {kind:'interactive';interactive:InteractiveMessage} | {kind:'media';media:MediaPayload} | {kind:'template';template:OutboundTemplate}`; `OutboundRequest { threadId:string; platform:string; payload:OutboundPayload; meta:OutboundMeta }`; `OutboundMeta { window:WindowState; parts:HarnessStreamPart[]; sessionId:string; userId?:string }` (import `WindowState` from `../adapter/window-store.js` — do NOT redefine); `DeferReason` (string-union: `'window-closed' | 'window-closed-no-recovery' | string` — keep open); `SendOutcome = {kind:'sent';result:SendResult} | {kind:'converted';result:SendResult;template:string;from:string} | {kind:'deferred';reason:DeferReason} | {kind:'suppressed';reason:string}`.
2. `OutboundPipeline` in `messaging/src/adapter/outbound-pipeline.ts`: `constructor(mw: OutboundMiddleware[], sink: OutboundSink)`; `send(req): Promise<SendOutcome>` runs the ordered chain terminating in the sink (the §7 recursive `run(i)` shape).
3. **Constructor assertion (R-09):** throws if no middleware named `window-guard` is present (`'window-guard middleware is required (window safety)'`), AND throws if `window-guard` is present but **not the last** middleware (`'window-guard must be terminal'`). 
4. Terminal sink maps `OutboundPayload` → sink method (`text`→`sendText`, `interactive`→`sendInteractive`, `media`→`sendMedia`, `template`→ `isTemplateCapable(sink)` ? `sendTemplate` : throw `'no template capability'`). Outcomes: free-form/`template` success → `{kind:'sent', result}` (template success may be `{kind:'sent'}` in S1; the `converted` outcome is set by the Sprint-2 strategist, not the sink).
5. Tests: `pipeline_composes` (a pass-through middleware + window-guard + sink sends text); `window_guard_required` (no `window-guard` → constructor throws); `window_guard_terminal` (window-guard not last → constructor throws).

**Files:** modify `packages/kuralle-messaging/src/types/outbound.ts`; create `packages/kuralle-messaging/src/adapter/outbound-pipeline.ts`; modify `messaging/src/index.ts`; create `packages/kuralle-messaging/test/outbound-pipeline.test.ts`.

**Demo artifact:** `sprints/sprint-1/artifacts/s1-02-tests.txt`.

### `S1-03` — A3: windowGuard + wire into router + close the two bypasses

**Description:** Add the `windowGuard` middleware; wire the `OutboundPipeline` into `createMessagingRouter` so the `StreamMapper`'s sends traverse it; and **close the two direct-send bypasses** (router `fallbackMessage`, custom `responseMapper`) plus deprecate the public `WhatsAppClient.sendTextOrTemplate` direct-send escape (R-02/R-02-S/REQ-17).

**Acceptance criteria** (priority order):
1. `windowGuard` middleware (`messaging/src/adapter/middleware/window-guard.ts`): `{ name:'window-guard', async send(req,next) { if (req.payload.kind === 'template') return next(req); if (req.meta.window.open) return next(req); return { kind:'deferred', reason:'window-closed' }; } }`. (Gates text/media/interactive equally — REQ-16.)
2. `createMessagingRouter` builds `const windowStore = config.windowStore ?? new InMemoryWindowStore()`; on inbound calls `windowStore.recordInbound(threadId, ts)`; on status with `conversation.expirationTimestamp` calls `windowStore.recordExpiry`. Per platform constructs `new OutboundPipeline([windowGuard, ...(config.outbound ?? [])-but-windowGuard-last], platform)` — see note: the **default chain is `[windowGuard]`** and `windowGuard` must remain terminal; if `config.outbound` middleware are supplied they are installed **before** `windowGuard`. (`MessagingRouterConfig` gains `outbound?: OutboundMiddleware[]` and `windowStore?: WindowStore`.)
3. `StreamMapper.mapStream` is reshaped to route every send through a provided `OutboundPipeline` instead of calling `platform.sendText`/etc. directly: it builds `meta = { window: await windowStore.get(threadId), parts, sessionId, userId }` and calls `pipeline.send({ threadId, platform: platform.platform, payload, meta })`. The default text response and the custom `responseMapper` both go through the pipeline. (`StreamMapper` gains the pipeline + windowStore + sessionId via `StreamMapperOptions` or method args.)
4. **Bypass closure (REQ-17):**
   - Router `fallbackMessage` send (`createMessagingRouter.ts:81`) goes through `pipeline.send({payload:{kind:'text',text:fallbackMessage}, ...})`, not `platform.sendText`.
   - Custom `responseMapper`: the `ResponseContext.sendText/sendInteractive/sendMedia` closures are **rebound to the pipeline** (each builds an `OutboundPayload` and calls `pipeline.send`), so a custom mapper physically cannot reach the client directly. (Public `ResponseMapper`/`ResponseContext` interface shape is preserved; only the closures' target changes — documented in the README/RFC delta note.)
   - `WhatsAppClient.sendTextOrTemplate` (`client.ts:287`) gets a `@deprecated` JSDoc pointing at the pipeline (it is a direct-send escape that bypasses the guard); no internal caller uses it after this story.
5. Tests (fake-client, offline): `window_closed_blocks_freeform` (window closed ⇒ `sink.sendText` call count === 0; outcome `deferred`); `window_closed_blocks_media_and_interactive` (same for media + interactive payloads); `fallback_and_custom_mapper_route_through_pipeline` (a closed window ⇒ neither the router fallback nor a custom `responseMapper` reaches the client; both yield `deferred`/zero client calls). Window-**open** path still sends (regression: existing `unhappy-paths.test.ts` etc. stay green — the router records inbound, so the window is open when replying).

**Files:** create `packages/kuralle-messaging/src/adapter/middleware/window-guard.ts`; modify `packages/kuralle-messaging/src/adapter/{createMessagingRouter.ts,stream-mapper.ts}`, `packages/kuralle-messaging/src/types/adapter.ts` (config + `ResponseContext`/`StreamMapperOptions`), `packages/kuralle-messaging/src/index.ts`, `packages/kuralle-messaging-meta/src/whatsapp/client.ts` (`@deprecated`); create `packages/kuralle-messaging/test/window-guard.test.ts` (+ extend router tests).

**Demo artifact:** `sprints/sprint-1/artifacts/s1-03-tests.txt` (fake-client transcript: closed window ⇒ zero free-form client calls).

---

## 2. Universal DoD checklist (per story)

- [ ] All acceptance criteria met.
- [ ] Unit tests for every new exported function/class — ≥1 happy + ≥1 failure path, offline fake-client (`messaging/test`).
- [ ] `bun run build` green (rebuild `messaging`/`messaging-meta`); `bun run typecheck:all` green.
- [ ] Public surfaces match RFC §4.1/§4.2 (and the `ResponseMapper`/`MessagingRouterConfig` reshape carries a README/RFC-delta doc note in S1-03).
- [ ] `HarnessStreamPart` unchanged.
- [ ] No `--no-verify`, no type-suppression, no silent catch.
- [ ] Atomic commit `[S1-{nn}] {title}` on `plan/whatsapp-engagement`; `.handoff/proof-s1-{nn}.json` written.

---

## 3. Test plan

| Story | Layer | Named fail-to-pass tests |
|-------|-------|--------------------------|
| S1-01 | unit | `capability_detection` (true/false) |
| S1-02 | unit | `pipeline_composes`, `window_guard_required`, `window_guard_terminal` |
| S1-03 | unit (fake-client) | `window_closed_blocks_freeform`, `window_closed_blocks_media_and_interactive`, `fallback_and_custom_mapper_route_through_pipeline` |

**Not tested this sprint (safe):** template conversion / `converted` outcome (no strategist until Sprint 2 → guard defers, never converts); `consentGate`/`ownershipGate` (engagement, Sprint 4); `ChannelPolicy` injection into the guard (Sprint 6). All offline; no live Meta API.

---

## 4. Demo plan

**Demo:** offline fake-client transcript — with the window **closed**, a `reply`/media/interactive send produces **zero** client free-form calls (outcome `deferred`); with the window **open**, it sends. Captured in `artifacts/s1-0N-*.txt`.

---

## 5. Risks specific to this sprint

| Risk | Detection | Mitigation |
|------|-----------|------------|
| `StreamMapper`→pipeline reshape breaks the happy path | existing `unhappy-paths.test.ts` / router tests go red | window is open right after `recordInbound`, so open-window sends still fire; run the full `messaging` suite each story. |
| `responseMapper` reshape is a public-surface change | consumers of `ResponseMapper` break | preserve the interface shape; only rebind the context closures to the pipeline; doc note in README + RFC delta. |
| `window-guard` not terminal → a later middleware leaks free-form | n/a in S1 (chain is `[windowGuard]`) | constructor asserts terminal; test `window_guard_terminal`. |
| `OutboundTemplate` reshaped in Sprint 2 (component-aware) | Sprint 2 churn | define minimal neutral shape now; `components?` added additively in B2 — flagged. |
| `sendTextOrTemplate` still callable (direct-send escape) | a caller bypasses the guard | `@deprecated` + no internal caller; full wrap/removal deferred (note in WARMDOWN). |

---

## 6. Open questions

- None blocking. The guard-reads-`meta.window` vs guard-holds-`WindowStore` choice is resolved in §0 (driver reads the store, populates meta, guard reads meta — single read, pure guard, fail-closed preserved). If an IC finds the `StreamMapper` reshape forces a public-surface change beyond `ResponseContext` closures + `MessagingRouterConfig.{outbound,windowStore}` + `StreamMapperOptions`, **stop and flag** before widening the surface.
