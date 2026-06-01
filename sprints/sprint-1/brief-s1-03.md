# Story Brief — `S1-03` A3: windowGuard + wire into router + close the two bypasses

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end before coding. Ambiguity/contradiction with disk → **stop and ask**. This is the largest story of the sprint — read §3 and §4 fully before writing.
>
> **Atomic-commit:** finish → `[S1-03] A3 windowGuard + pipeline wiring + close bypasses` on **`plan/whatsapp-engagement`**. No push, no `main`, one commit.
>
> **Runtime:** Bun. `bun test`.

---

## 1. Goal

Add the `windowGuard` middleware; wire the `OutboundPipeline` into `createMessagingRouter` so the `StreamMapper`'s sends traverse it; and **close the two direct-send bypasses** (router `fallbackMessage` and the custom `responseMapper`), plus `@deprecate` the `WhatsAppClient.sendTextOrTemplate` escape. Result: a closed-window free-form send (text/media/interactive) produces **zero** client send calls — it defers. Proven by `window_closed_blocks_freeform`, `window_closed_blocks_media_and_interactive`, `fallback_and_custom_mapper_route_through_pipeline`.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md`; `sprints/sprint-1/PLAN.md` § Story `S1-03` + § 0 (esp.: guard reads `req.meta.window.open`; driver populates `meta.window` from `WindowStore.get`; default chain is `[windowGuard]`; closed ⇒ **defer**, never convert).
2. RFC: `02-requirements-interfaces.md` **§4.1** (windowGuard behavior, default chain), **§4.9** (WindowStore), **REQ-1/2/3/16/17**; `03-pseudocode-blueprint.md` **§6.1** (the leak invariant + the bypass-closure note naming `createMessagingRouter.ts:81` and `stream-mapper.ts:82-89`); `05-security-rollback-open-qs.md` **R-01/R-02/R-02-S/R-09**; `04-tasks-validation.md` **A3** + **§9.1** tests.
3. Source (read all before editing):
   - `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` — the router. Note: `windowTracker.recordInbound` (~line 63), `const input = message.text ?? '[type]'` (leave as-is — Sprint 3 owns it), `streamMapper.mapStream(...)` (~83), and the **fallback bypass** `platform.sendText(message.threadId, fallbackMessage)` (~line 90, inside the catch).
   - `packages/kuralle-messaging/src/adapter/stream-mapper.ts` — `mapStream(stream, platform, threadId, options)`; the default path calls `platform.sendText(threadId, formatted)` (`defaultMapResponse`); the **custom-mapper bypass** hands raw `sendText`/`sendInteractive`/`sendMedia` closures bound to `platform` (lines ~82-89).
   - `packages/kuralle-messaging/src/types/adapter.ts` — `MessagingRouterConfig`, `ResponseMapper`, `ResponseContext`, `StreamMapperOptions`.
   - `packages/kuralle-messaging/src/adapter/{window-store.ts,outbound-pipeline.ts}` — `InMemoryWindowStore`, `WindowStore`, `WindowState` (S0-04); `OutboundPipeline` + `OutboundRequest`/`OutboundPayload`/`OutboundMeta`/`SendOutcome`/`OutboundMiddleware` (S1-01/S1-02).
   - `packages/kuralle-messaging-meta/src/whatsapp/client.ts` — `sendTextOrTemplate` (~287) to `@deprecate`.
   - Test fixtures: `packages/kuralle-messaging/test/unhappy-paths.test.ts` (`createMockPlatform` recording sends; `createMockRuntime` from `@kuralle-agents/core/testing`).

> **Depends on S1-01 + S1-02** (both committed). `bun run build` first (fresh dist).

---

## 3. Files you will create or modify

**Create** `packages/kuralle-messaging/src/adapter/middleware/window-guard.ts`:
```ts
import type { OutboundMiddleware, OutboundRequest, OutboundNext, SendOutcome } from '../../types/outbound.js';

/** Non-removable, terminal middleware: blocks free-form payloads outside the window (REQ-1/REQ-16).
 *  Templates are window-agnostic and pass. A closed window DEFERS (Sprint 2 adds template conversion). */
export const windowGuard: OutboundMiddleware = {
  name: 'window-guard',
  async send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome> {
    if (req.payload.kind === 'template') return next(req);
    if (req.meta.window.open) return next(req);
    return { kind: 'deferred', reason: 'window-closed' };
  },
};
```

**Modify** `packages/kuralle-messaging/src/types/adapter.ts`:
- `MessagingRouterConfig`: add `outbound?: OutboundMiddleware[];` and `windowStore?: WindowStore;` (import the types).
- Keep the `ResponseMapper`/`ResponseContext` **interface shapes unchanged** (public surface preserved) — only their *implementation* (the closures passed in) changes in `stream-mapper.ts`. (Document the behavioral change in the README delta — see §5.)
- `StreamMapperOptions`: add the fields the mapper needs to reach the pipeline — `pipeline?: OutboundPipeline; windowStore?: WindowStore; sessionId?: string; userId?: string;` (or pass them as explicit `mapStream` args — your call, but keep it typed, no `any`).

**Modify** `packages/kuralle-messaging/src/adapter/stream-mapper.ts`:
- `mapStream` must route **every** send through the provided `OutboundPipeline` instead of `platform.sendText`/etc.
- Build `meta` once per send: `const window = await windowStore.get(threadId); const meta: OutboundMeta = { window, parts, sessionId, userId };`.
- Default text path: instead of `platform.sendText(threadId, formatted)`, call `await pipeline.send({ threadId, platform: platform.platform, payload: { kind: 'text', text: formatted }, meta });`.
- Custom `responseMapper` path: **rebind the `ResponseContext` closures to the pipeline** — `sendText: (text) => pipeline.send({ threadId, platform: platform.platform, payload:{kind:'text',text}, meta }).then(toSendResultOrThrow)`, and likewise `sendInteractive`/`sendMedia` with `{kind:'interactive',interactive}` / `{kind:'media',media}`. The closures MUST NOT call `platform.*` directly. (A deferred/suppressed outcome has no `SendResult`; for the closure's `Promise<SendResult>` return type, on a non-`sent`/`converted` outcome return a synthetic `SendResult`-shaped "not sent" marker OR change the closure return to `Promise<SendOutcome>` — prefer returning the `SendOutcome` and adjust `ResponseContext` to `Promise<SendOutcome>`; if that widens the public surface more than acceptable, return a `SendResult` with an empty `messageId` and document it. Pick the cleaner option and note it.)
- Typing indicator behavior unchanged.
- If `pipeline` is not provided (back-compat / unit calls), you MAY fall back to the old direct-send path — BUT the router (below) always provides it, so the production path is always pipeline-routed. Keep the fallback only if it avoids breaking existing direct `StreamMapper` unit tests; otherwise make `pipeline` required. Prefer **required** (cleaner; update any direct-StreamMapper tests).

**Modify** `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts`:
- `const windowStore = config.windowStore ?? new InMemoryWindowStore();` (replace the bare `new WindowTracker()` usage — `recordInbound`/`recordExpiry` now go through `windowStore`).
- Per platform: `const pipeline = new OutboundPipeline(buildChain(config.outbound), platform);` where `buildChain(extra) = [...(extra ?? []), windowGuard]` (windowGuard **last/terminal** — the pipeline constructor enforces this).
- On inbound: `windowStore.recordInbound(message.threadId, message.timestamp);`. On status with `conversation.expirationTimestamp`: `windowStore.recordExpiry(...)`.
- Pass `pipeline`, `windowStore`, `sessionId`, `userId` into `streamMapper.mapStream(...)`.
- **Fallback bypass (REQ-17):** replace `await platform.sendText(message.threadId, fallbackMessage)` with a pipeline send:
  ```ts
  const window = await windowStore.get(message.threadId);
  await pipeline.send({ threadId: message.threadId, platform: name, payload: { kind: 'text', text: fallbackMessage }, meta: { window, parts: [], sessionId, userId } });
  ```
  (Wrap in its own try/catch as today — a failed fallback is non-fatal.)

**Modify** `packages/kuralle-messaging/src/index.ts` — export `windowGuard`.

**Modify** `packages/kuralle-messaging-meta/src/whatsapp/client.ts` — add a `@deprecated` JSDoc to `sendTextOrTemplate` (it bypasses the window-safe pipeline; callers should route through the OutboundPipeline). Do not delete it (callers outside this repo may use it); just deprecate. Confirm no internal caller in `messaging`/`messaging-meta` uses it.

**Create** `packages/kuralle-messaging/test/window-guard.test.ts` (+ extend router/stream-mapper tests as needed).

**Do not touch:** the `const input = message.text ?? '[type]'` derivation (Sprint 3). No `consentGate`/`ownershipGate` (Sprint 4). No `ChannelPolicy` injection into the guard (Sprint 6). No strategist/template conversion (Sprint 2).

---

## 4. Acceptance criteria (priority order)

1. `windowGuard` middleware exists, name `'window-guard'`, defers free-form (text/media/interactive) when `req.meta.window.open === false`, passes templates and open-window payloads.
2. `createMessagingRouter` builds an `OutboundPipeline` per platform with `windowGuard` terminal; uses `WindowStore` (default `InMemoryWindowStore`) for `recordInbound`/`recordExpiry`; `MessagingRouterConfig` gains `outbound?` + `windowStore?`.
3. `StreamMapper` routes the default text response AND the custom `responseMapper` sends through the pipeline; the custom mapper's context closures cannot reach the client directly.
4. Router `fallbackMessage` is sent through the pipeline, not `platform.sendText`.
5. `WhatsAppClient.sendTextOrTemplate` is `@deprecated`; no internal caller uses it.
6. **`window_closed_blocks_freeform`** — fake-client: window closed (`windowStore.get` → `{open:false}`, e.g. never `recordInbound`, or `recordExpiry` in the past) ⇒ a text send through the router/pipeline yields outcome `deferred` and `sink.sendText` call count === **0**.
7. **`window_closed_blocks_media_and_interactive`** — same, for `{kind:'media'}` and `{kind:'interactive'}` payloads (count 0, deferred).
8. **`fallback_and_custom_mapper_route_through_pipeline`** — with a closed window: (a) the router's catch-path `fallbackMessage` does NOT reach `platform.sendText` (deferred); (b) a custom `responseMapper` calling `context.sendText(...)` does NOT reach `platform.sendText` (deferred). Both yield zero client free-form calls.
9. **Open-window regression:** existing `messaging` tests stay green — after `recordInbound`, the window is open, so a reply still sends (`sink.sendText` fires). Run the full `messaging` suite.
10. `bun run build` + `bun run typecheck:all` green; `bun test packages/kuralle-messaging packages/kuralle-messaging-meta` green.

---

## 5. Doc note (REQUIRED — public-surface change)

The `ResponseMapper`/`ResponseContext` behavior changes: the context's `sendText`/`sendInteractive`/`sendMedia` now route through the window-safe `OutboundPipeline` (they no longer call the platform client directly; a closed-window send defers). Add a short note to `packages/kuralle-messaging/README.md` (a "Window-safe outbound" subsection): every send — default, custom `responseMapper`, and router fallback — traverses the `OutboundPipeline` with a non-removable `windowGuard`; closed-window free-form sends defer. Mention `MessagingRouterConfig.windowStore?`/`outbound?` and the `sendTextOrTemplate` deprecation. (If there's no README, create a minimal one with this section.)

---

## 6. What NOT to do

- No template conversion / strategist (Sprint 2) — closed window **defers**, full stop.
- No `consentGate`/`ownershipGate`/`ChannelPolicy` (Sprints 4/6).
- Do not change the `input = message.text ?? '[type]'` derivation (Sprint 3).
- Do not widen the public surface beyond `MessagingRouterConfig.{outbound,windowStore}`, `StreamMapperOptions` additions, and the documented `ResponseContext` closure-behavior change. If you think you must, **stop and flag**.
- No `any`, `@ts-ignore`, `--no-verify`, silent catch (the fallback try/catch is pre-existing and intentional — keep its shape).

---

## 7. Validation contract (`.handoff/proof-s1-03.json`)

`assertions_required`:
- `REQ-1` · `REQ-16` · `REQ-17`
- `test:window_closed_blocks_freeform`
- `test:window_closed_blocks_media_and_interactive`
- `test:fallback_and_custom_mapper_route_through_pipeline`
- `cmd:typecheck_all`

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| guard-test | `bun test packages/kuralle-messaging/test/window-guard.test.ts` | REQ-1, REQ-16, test:window_closed_blocks_freeform, test:window_closed_blocks_media_and_interactive |
| router-test | `bun test packages/kuralle-messaging` | REQ-17, test:fallback_and_custom_mapper_route_through_pipeline (regression: open-window sends still fire) |
| meta-suite | `bun test packages/kuralle-messaging-meta` | REQ-17 (sendTextOrTemplate deprecation, no internal caller) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`** only (`bun test`→`test_suite`, `typecheck:all`→`typecheck`).
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`id:"guard-test"` → `.handoff/proof-s1-03-guard-test.stdout`); plus `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- Each `commands_run[]` row: `purpose` = literal `"verification"`; `claim_id` matches a `claims[].id`.
- `assertions_satisfied` == `assertions_required`. Sentinel: `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s1-03.json" > .handoff/result-s1-03.done`.

---

## 8. Demo artifact

`sprints/sprint-1/artifacts/s1-03-tests.txt` — the named tests passing (showing closed-window ⇒ zero free-form client calls / `deferred`) + typecheck tail. Commit it.

---

## 9. Report back

Files changed, commit sha, proof slug `s1-03`, DoD ticked, demo path, and one paragraph of trade-offs — especially: how you typed the rebound `ResponseContext` closures (return `SendOutcome` vs synthetic `SendResult`), and confirmation no internal caller uses `sendTextOrTemplate`. **No root `*-implementation-notes.md`.** No PR.

---

## 10. If stuck

- The `ResponseContext` closure return-type tension (§3) is the one real design choice — pick the cleaner typing, implement it, and explain it in your report. Do NOT use `any` to dodge it.
- If wiring the pipeline into `StreamMapper` forces a public-surface change beyond §6's allowed set, **stop and flag** before widening.
- Baseline green pre-story. A failure traces to your change. No shortcuts.
