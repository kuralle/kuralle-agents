# Story Brief — `S1-02` A2: OutboundPipeline + middleware contract

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end before coding. Ambiguity/contradiction with disk → **stop and ask**.
>
> **Atomic-commit:** finish → `[S1-02] A2 OutboundPipeline + middleware contract` on **`plan/whatsapp-engagement`**. No push, no `main`, one commit.
>
> **Runtime:** Bun. `bun test`.

---

## 1. Goal

Add the middleware/pipeline types and the `OutboundPipeline` class to `@kuralle-agents/messaging`. The constructor enforces the non-removable safety invariant: a middleware named `window-guard` must be present **and terminal** (the last middleware before the sink). Proven by `pipeline_composes`, `window_guard_required`, `window_guard_terminal`.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md`; `sprints/sprint-1/PLAN.md` § Story `S1-02` + § 0.
2. RFC: `02-requirements-interfaces.md` **§4.1** (OutboundMiddleware/OutboundNext/OutboundRequest/OutboundPayload/OutboundMeta/WindowState/SendOutcome/OutboundPipeline); `03-pseudocode-blueprint.md` **§6.1** (sink mapping) + **§7** (the `OutboundPipeline` class sketch: recursive `run(i)`); `04-tasks-validation.md` **A2** + **§9.1** `window_guard_required`.
3. Source:
   - `packages/kuralle-messaging/src/types/outbound.ts` — created in **S1-01** (`OutboundSink`, `OutboundTemplate`, `isTemplateCapable`). You ADD the pipeline types here.
   - `packages/kuralle-messaging/src/adapter/window-store.ts` — exports `WindowState` (S0-04). **Import it; do not redefine.**
   - `packages/kuralle-messaging/src/types/{responses.ts,messages.ts}` — `SendResult`, `InteractiveMessage`, `MediaPayload`.
   - `@kuralle-agents/core` exports `HarnessStreamPart` (for `OutboundMeta.parts`).
   - `packages/kuralle-messaging/src/index.ts` — export the new pipeline class + types.
   - Test fixture: `packages/kuralle-messaging/test/unhappy-paths.test.ts` (`createMockPlatform`) for an `OutboundSink` stand-in.

> **Depends on S1-01** (`types/outbound.ts` + `OutboundSink`/`OutboundTemplate`/`isTemplateCapable`). It is committed. Run `bun run build` once at the start so dist is fresh.

---

## 3. Files you will create or modify

**Modify** `packages/kuralle-messaging/src/types/outbound.ts` — add:
```ts
import type { HarnessStreamPart } from '@kuralle-agents/core';
import type { WindowState } from '../adapter/window-store.js';
// (SendResult, InteractiveMessage, MediaPayload, OutboundTemplate already imported/defined from S1-01)

export type OutboundPayload =
  | { kind: 'text'; text: string }
  | { kind: 'interactive'; interactive: InteractiveMessage }
  | { kind: 'media'; media: MediaPayload }
  | { kind: 'template'; template: OutboundTemplate };

export interface OutboundMeta {
  window: WindowState;
  parts: HarnessStreamPart[];
  sessionId: string;
  userId?: string;
}

export interface OutboundRequest {
  threadId: string;
  platform: string;
  payload: OutboundPayload;
  meta: OutboundMeta;
}

export type DeferReason = 'window-closed' | 'window-closed-no-recovery' | (string & {});

export type SendOutcome =
  | { kind: 'sent'; result: SendResult }
  | { kind: 'converted'; result: SendResult; template: string; from: string }
  | { kind: 'deferred'; reason: DeferReason }
  | { kind: 'suppressed'; reason: string };

export type OutboundNext = (req: OutboundRequest) => Promise<SendOutcome>;

export interface OutboundMiddleware {
  readonly name: string;
  send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome>;
}
```

**Create** `packages/kuralle-messaging/src/adapter/outbound-pipeline.ts`:
```ts
import type { OutboundMiddleware, OutboundRequest, OutboundNext, SendOutcome } from '../types/outbound.js';
import type { OutboundSink } from '../types/outbound.js';
import { isTemplateCapable } from '../types/outbound.js';

const WINDOW_GUARD = 'window-guard';

export class OutboundPipeline {
  constructor(
    private readonly mw: OutboundMiddleware[],
    private readonly sink: OutboundSink,
  ) {
    const idx = mw.findIndex((m) => m.name === WINDOW_GUARD);
    if (idx === -1) {
      throw new Error('window-guard middleware is required (window safety)');
    }
    if (idx !== mw.length - 1) {
      throw new Error('window-guard must be terminal (the last middleware before the sink)');
    }
  }

  send(req: OutboundRequest): Promise<SendOutcome> {
    const run = (i: number, r: OutboundRequest): Promise<SendOutcome> =>
      i < this.mw.length
        ? this.mw[i].send(r, (nr: OutboundRequest) => run(i + 1, nr))
        : this.terminal(r);
    return run(0, req);
  }

  private async terminal(r: OutboundRequest): Promise<SendOutcome> {
    const { payload, threadId } = r;
    switch (payload.kind) {
      case 'text':
        return { kind: 'sent', result: await this.sink.sendText(threadId, payload.text) };
      case 'interactive':
        return { kind: 'sent', result: await this.sink.sendInteractive(threadId, payload.interactive) };
      case 'media':
        return { kind: 'sent', result: await this.sink.sendMedia(threadId, payload.media) };
      case 'template': {
        const sink = this.sink as OutboundSink & { sendTemplate?: unknown };
        // OutboundSink defines sendTemplate?; the cast to PlatformClient is only for the guard.
        if (typeof sink.sendTemplate !== 'function') {
          throw new Error('sink has no template capability');
        }
        return { kind: 'sent', result: await this.sink.sendTemplate!(threadId, payload.template) };
      }
    }
  }
}
```
*(Note: the `isTemplateCapable` import is for parity with §6.1; if you prefer, gate the `template` branch with `isTemplateCapable(this.sink as PlatformClient)` — but the sink is typed `OutboundSink` whose `sendTemplate?` is optional, so a `typeof … === 'function'` check on the sink is the clean form. Use whichever typechecks without `any`; do not import `PlatformClient` just to satisfy the guard if a local `typeof` check is cleaner. No template payload is exercised this sprint — the guard defers — so this branch is correctness-by-construction, not a tested path. Keep it correct and minimal.)*

**Modify** `packages/kuralle-messaging/src/index.ts` — export `OutboundPipeline` and the new types (`OutboundMiddleware`, `OutboundNext`, `OutboundRequest`, `OutboundPayload`, `OutboundMeta`, `SendOutcome`, `DeferReason`).

**Create** `packages/kuralle-messaging/test/outbound-pipeline.test.ts`.

**Do not touch:** the router/stream-mapper (S1-03), `windowGuard` (S1-03 — but you MAY define a trivial `{name:'window-guard', send:(r,n)=>n(r)}` pass-through *inside the test* to satisfy the constructor). No `messaging-meta`.

---

## 4. Acceptance criteria (priority order)

1. All §3 types added to `types/outbound.ts`; `WindowState` imported from `window-store.js` (NOT redefined).
2. `OutboundPipeline` runs the ordered middleware chain terminating in the sink; the terminal maps each `OutboundPayload.kind` to the matching sink method; `template` throws if the sink lacks `sendTemplate`.
3. **Constructor throws** `'window-guard middleware is required (window safety)'` when no middleware is named `window-guard`.
4. **Constructor throws** (terminal assertion) when `window-guard` is present but is **not the last** middleware.
5. `pipeline_composes`: a chain `[passThrough, windowGuardStub]` + a recording sink sends a `{kind:'text'}` payload → sink.sendText called once, outcome `{kind:'sent'}`; the pass-through middleware ran (e.g. it tags `req` or increments a counter).
6. `window_guard_required`: `new OutboundPipeline([passThrough], sink)` throws (no window-guard).
7. `window_guard_terminal`: `new OutboundPipeline([windowGuardStub, passThrough], sink)` throws (guard not last).
8. `bun run build` + `bun run typecheck:all` green; `bun test packages/kuralle-messaging` green.

---

## 5. What NOT to do

- No `windowGuard` real middleware, no router/stream-mapper wiring (S1-03).
- Do not redefine `WindowState`.
- Do not change `OutboundSink`/`OutboundTemplate`/`isTemplateCapable` from S1-01 (only ADD to the file).
- No `any`, no `@ts-ignore`, no `--no-verify`, no silent catch.

---

## 6. Validation contract (`.handoff/proof-s1-02.json`)

`assertions_required`:
- `REQ-2` (window enforcement cannot be silently bypassed — the non-removable guard)
- `test:pipeline_composes`
- `test:window_guard_required`
- `test:window_guard_terminal`
- `cmd:typecheck_all`

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| pipeline-test | `bun test packages/kuralle-messaging/test/outbound-pipeline.test.ts` | REQ-2, test:pipeline_composes, test:window_guard_required, test:window_guard_terminal |
| msg-suite | `bun test packages/kuralle-messaging` | REQ-2 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`** only (`bun test`→`test_suite`, `typecheck:all`→`typecheck`).
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`id:"pipeline-test"` → `.handoff/proof-s1-02-pipeline-test.stdout`); plus `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- Each `commands_run[]` row: `purpose` = literal `"verification"`; `claim_id` matches a `claims[].id`.
- `assertions_satisfied` == `assertions_required`. Sentinel: `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s1-02.json" > .handoff/result-s1-02.done`.

---

## 7. Demo artifact

`sprints/sprint-1/artifacts/s1-02-tests.txt` — the 3 named tests passing + typecheck tail. Commit it.

---

## 8. Report back

Files changed, commit sha, proof slug `s1-02`, DoD ticked, demo path, trade-offs. **No root `*-implementation-notes.md`** (notes go in your report). No PR.

---

## 9. If stuck

- Missing S1-01 symbol → stop, report. (S1-01 created `types/outbound.ts` — if it's absent, the dependency didn't land; stop.)
- No shortcuts; baseline green pre-story.
