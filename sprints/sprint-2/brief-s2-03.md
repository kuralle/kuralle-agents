# Story Brief — `S2-03` B3: strategistMiddleware + smartSend node

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end. Ambiguity → **stop and ask**.
>
> **Atomic-commit:** `[S2-03] B3 strategistMiddleware + smartSend node` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

---

## 1. Goal

Wire the strategist into the outbound path as `strategistMiddleware` (installed **before** the terminal `windowGuard`) and as a `smartSend` action node sharing the **same** strategist instance. Proven by `node_guard_parity`, `strategist_middleware_converts_closed_window`, `strategist_middleware_defers_when_no_fit`.

---

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-2/PLAN.md` § Story `S2-03` + § 0 (esp. the strategist-before-terminal-guard design: middleware converts closed-window free-form→template so the now-template payload passes the guard; guard stays the non-removable backstop).
2. RFC `02-requirements-interfaces.md` **§4.4** (`strategistMiddleware`, `smartSend`), **§4.5** (`smartSend` author surface); `03-pseudocode-blueprint.md` **§6.1/§6.2**; **REQ-4** (one strategist, used as default guard AND the explicit node).
3. Source:
   - `packages/kuralle-engagement/src/strategist.ts` — `SmartSendStrategist`, `SendDecision`, `StrategistInput` (S2-01).
   - `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundMiddleware`, `OutboundRequest`, `OutboundNext`, `SendOutcome`, `OutboundPayload`, `WindowState`.
   - `packages/kuralle-messaging/src/adapter/middleware/window-guard.ts` — the terminal guard (S1-03); your middleware runs **before** it via `config.outbound`.
   - `packages/kuralle-messaging/src/adapter/outbound-pipeline.ts` — constructor requires `window-guard` terminal (your middleware must NOT be named `window-guard` and must be ordered before it).
   - `packages/kuralle-core/src/types/flow.ts` — `action(node)`, `ActionNode.run: (state, ctx) => Transition | Promise<Transition>`, `Transition`. `smartSend` returns an `action` node (no new FlowNode kind — REQ-9).
   - `packages/kuralle-engagement/src/index.ts` — export `strategistMiddleware`, `smartSend`.
   - Test pattern: `packages/kuralle-messaging/test/outbound-pipeline.test.ts` (+ S2-01's strategist test) for fixtures.

> `bun run build` first (S2-01 strategist in dist).

---

## 3. Files & specs

**Create `packages/kuralle-engagement/src/strategist-middleware.ts`**:
```ts
import type { OutboundMiddleware, OutboundRequest, OutboundNext, SendOutcome } from '@kuralle-agents/messaging';
import type { SmartSendStrategist, StrategistInput } from './strategist.js';

export function strategistMiddleware(strategist: SmartSendStrategist): OutboundMiddleware {
  return {
    name: 'strategist',
    async send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome> {
      // Only free-form text is a conversion candidate; non-text free-form & templates pass through
      // to the windowGuard unchanged (media/interactive on a closed window still defer at the guard).
      if (req.payload.kind !== 'text') return next(req);
      const input: StrategistInput = { text: req.payload.text, window: req.meta.window };
      const decision = await strategist.decide(input);
      switch (decision.kind) {
        case 'freeform':
          return next(req);
        case 'template':
          return next({ ...req, payload: { kind: 'template', template: decision.template } });
        case 'defer':
          return { kind: 'deferred', reason: decision.reason };
      }
    },
  };
}
```
*(Rationale: the strategist's `decide` already short-circuits window-open → `freeform` (no selector call). On a closed window it converts text→template or defers. Media/interactive payloads are passed through to the terminal `windowGuard`, which defers them on a closed window — Sprint 2 only recovers text via templates, matching the demo. Note this scope in your report.)*

**Create `packages/kuralle-engagement/src/nodes.ts`** — `smartSend`:
```ts
import { action } from '@kuralle-agents/core';
import type { ActionNode, FlowState, Transition } from '@kuralle-agents/core';
import type { SmartSendStrategist, SendDecision, WindowState } from './strategist.js';

export function smartSend(strategist: SmartSendStrategist, node: {
  id: string;
  message: (s: FlowState) => string;
  intent?: string;
  window?: (s: FlowState) => WindowState;   // optional window source; default open (a flow runs in-session)
  next?: (d: SendDecision, s: FlowState) => Transition;
}): ActionNode {
  return action({
    id: node.id,
    run: async (state) => {
      const text = node.message(state);
      const window: WindowState = node.window?.(state) ?? { open: true, expiresAt: new Date() };
      const decision = await strategist.decide({ text, window, intent: node.intent });
      return node.next ? node.next(decision, state) : { stay: true };  // default: no transition
    },
  });
}
```
*(Confirm the exact `Transition` shape from `core/src/types/flow.ts` — `{stay:true}`/`{goto}`/`{end}`/`{escalate}` etc. Use the correct default "no-op/stay" transition for this codebase; adjust if `{stay:true}` is not the idiom.)*

**Modify `packages/kuralle-engagement/src/index.ts`** — export `strategistMiddleware`, `smartSend`.

**Create `packages/kuralle-engagement/test/strategist-middleware.test.ts`**.

**Do not touch:** `window-guard.ts`, the pipeline, the router (the middleware installs via `config.outbound` at the call site / in tests). No strategist-logic changes (S2-01). No catalog/selector changes (S2-02).

---

## 4. Acceptance criteria
1. `strategistMiddleware(s)` returns an `OutboundMiddleware` named `'strategist'` mapping `decide` → `freeform`⇒`next(req)`, `template`⇒`next({...req, payload:template})`, `defer`⇒`{deferred,reason}`; non-text payloads pass through.
2. `smartSend(strategist, {...})` returns an `action` node (kind `'action'`, no new FlowNode kind) that calls the **shared** strategist and routes via `next(decision, state)`.
3. **`node_guard_parity`**: build one strategist (mock catalog+selector); feed the same `(text, closed window)` to both the middleware (assert it calls `next` with a `template` payload OR returns `deferred`) and the `smartSend` node (assert the `SendDecision` passed to `next` is the same kind/template) → same decision. (Inject a deterministic mock selector so the decision is stable.)
4. **`strategist_middleware_converts_closed_window`**: pipeline `new OutboundPipeline([strategistMiddleware(s), windowGuard], sink)`, closed window, mock selector picks an approved template → the sink receives a **template** send (e.g. `sink.sendTemplate` called / outcome reaches sink as template); `sink.sendText` count 0.
5. **`strategist_middleware_defers_when_no_fit`**: same pipeline, closed window, mock catalog empty (or selector null) → outcome `deferred`, zero sink calls.
6. Window-open ⇒ free-form passes (carry a `window_open` assertion: middleware calls `next(req)` unchanged, zero selector calls).
7. The pipeline `[strategistMiddleware, windowGuard]` constructs without error (windowGuard terminal); `[windowGuard, strategistMiddleware]` would throw (guard not last) — you needn't test that (S1-02 covers it) but keep your ordering correct.
8. `bun run build` + `typecheck:all` green; `bun test` across touched packages green.

## 5. What NOT to do
- Don't rename/modify `windowGuard` or make it non-terminal.
- Don't change the strategist logic or the catalog/selector.
- No new `FlowNode` kind (`smartSend` is an `action`).
- No `any`, `@ts-ignore`, `--no-verify`, silent catch.

## 6. Validation contract (`.handoff/proof-s2-03.json`)
`assertions_required`: `REQ-4`, `test:node_guard_parity`, `test:strategist_middleware_converts_closed_window`, `test:strategist_middleware_defers_when_no_fit`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| mw-test | `bun test packages/kuralle-engagement/test/strategist-middleware.test.ts` | REQ-4, test:node_guard_parity, test:strategist_middleware_converts_closed_window, test:strategist_middleware_defers_when_no_fit |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-4 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s2-03-<id>.stdout`); plus `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose` = literal `"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied` == `assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s2-03.json" > .handoff/result-s2-03.done`.

## 7. Demo artifact
`sprints/sprint-2/artifacts/s2-03-tests.txt` — the named tests passing (closed-window text → template at sink; defer when no fit) + typecheck tail.

## 8. Report back
Files, commit sha, proof slug `s2-03`, DoD, demo path, trade-offs (esp. the `Transition` default you used for `smartSend`, and the media/interactive pass-through scope). **No root `*-implementation-notes.md`.** No PR.

## 9. If stuck
- Confirm the real `Transition` shape from `core/src/types/flow.ts` before writing `smartSend`'s default — don't guess `{stay:true}` if the codebase uses a different idiom.
- Baseline green pre-story. No shortcuts.
