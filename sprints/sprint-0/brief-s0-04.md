# Story Brief — `S0-04` A0.3/A0.4 `WindowStore` + `ChannelPolicy`/`webPolicy()`

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end before coding. Ambiguity/contradiction with disk → **stop and ask**.
>
> **Atomic-commit:** finish → `[S0-04] A0.3/A0.4 WindowStore + ChannelPolicy + webPolicy` on **`plan/whatsapp-engagement`** (confirm `git branch --show-current`). No push, no `main`, one commit.
>
> **Runtime:** Bun. `bun test`.

---

## 1. Goal

Two additive seams, no wiring:
- **(A0.3, `messaging`)** A `WindowStore` interface + `InMemoryWindowStore` (wraps the existing `WindowTracker`); an unknown/missing window is **fail-closed** → `{ open: false }`.
- **(A0.4, `engagement`)** `ChannelPolicy` / `ClosedWindowStrategy` types + `webPolicy()` — the trivial null adapter that proves the abstraction (`hasWindow:false`, `consentRequired:false`, `closedWindow:{kind:'none'}`, always-open).

Proven by `window_store_fail_closed` and `web_null_policy_always_open`. **No change to `createMessagingRouter`** — wiring is Sprint 1.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md`; `sprints/sprint-0/PLAN.md` § Story `S0-04` + § 0 (esp. the **type-dependency note** on forward-declaring `SmartSendStrategist` and defining `ChoiceOption`).
2. RFC: `rfcs/whatsapp-engagement/02-requirements-interfaces.md` **§4.9** (`WindowStore` — fail-closed), **§4.12** (`ChannelPolicy`, `ClosedWindowStrategy`, the Web adapter row), **REQ-18**, **REQ-22**; `04-tasks-validation.md` **A0.3/A0.4** + **§9.1** `window_store_fail_closed`, `web_null_policy_always_open`.
3. Source (the contract):
   - `packages/kuralle-messaging/src/adapter/window-tracker.ts` — `WindowTracker`: `recordInbound(threadId, ts)`, `recordExpiry(threadId, at)`, `isWindowOpen(threadId)`, `getExpiry(threadId): Date | null` (returns `null` on a miss). Your `InMemoryWindowStore` wraps this.
   - `packages/kuralle-messaging/src/types/messages.ts` — `InteractiveMessage` (lines 96-114): `{ type:'buttons'|'list'|'flow'; header?; body:string; footer?; action: InteractiveAction }`; `InteractiveAction` buttons variant is `{ type:'buttons'; buttons: {id:string;title:string}[] }`. `InboundMessage` (190-220) now has `customerId` (added in S0-02 — rebuild messaging first if you don't see it).
   - `packages/kuralle-messaging/src/index.ts` — export your new `WindowStore`/`WindowState`/`InMemoryWindowStore` here.
   - `packages/kuralle-engagement/src/index.ts` — currently `export {}`; export your policy types + `webPolicy`.
   - `@kuralle-agents/core` exports `ResolvedSelection` (added in S0-03 — rebuild core first).
   - Test style: `packages/kuralle-messaging/test/window-tracker.test.ts` (mirror for the WindowStore test); `packages/kuralle-messaging-meta/test/` or `kuralle-messaging/test/` for object-literal fixture style.

> **Dependency ordering:** this story depends on **S0-02** (`InboundMessage.customerId`) and **S0-03** (`ResolvedSelection` exported from core) being committed. They are. Run `bun run build` once at the start so `messaging`/`core` dist is fresh (stale-dist gotcha) before you compile `engagement` against them.

---

## 3. Files you will create or modify

**Create — `messaging`:**
- `packages/kuralle-messaging/src/adapter/window-store.ts`:
  ```ts
  import { WindowTracker } from './window-tracker.js';

  /** Window state value type (RFC §4.1/§4.9). */
  export type WindowState =
    | { open: true; expiresAt: Date }
    | { open: false; expiresAt: Date | null };

  /** Pluggable messaging-window store (RFC §4.9 / REQ-18). Fail-closed on a miss. */
  export interface WindowStore {
    get(threadId: string): Promise<WindowState>;
    recordInbound(threadId: string, ts: Date): Promise<void>;
    recordExpiry(threadId: string, at: Date): Promise<void>;
  }

  /** In-memory default; wraps WindowTracker. For single-process/dev (REQ-18 — durable adapter is backlog). */
  export class InMemoryWindowStore implements WindowStore {
    private readonly tracker: WindowTracker;
    constructor(tracker?: WindowTracker) { this.tracker = tracker ?? new WindowTracker(); }
    async get(threadId: string): Promise<WindowState> {
      const expiresAt = this.tracker.getExpiry(threadId);
      if (!expiresAt) return { open: false, expiresAt: null };        // fail closed on miss
      return expiresAt > new Date()
        ? { open: true, expiresAt }
        : { open: false, expiresAt };
    }
    async recordInbound(threadId: string, ts: Date): Promise<void> { this.tracker.recordInbound(threadId, ts); }
    async recordExpiry(threadId: string, at: Date): Promise<void> { this.tracker.recordExpiry(threadId, at); }
  }
  ```

**Create — `engagement`:**
- `packages/kuralle-engagement/src/policy.ts`:
  ```ts
  import type { InboundMessage, InteractiveMessage } from '@kuralle-agents/messaging';
  import type { ResolvedSelection } from '@kuralle-agents/core';

  /** Author-facing choice option (RFC §4.5). Stable shape. */
  export interface ChoiceOption {
    id: string;
    label: string;
    description?: string;
    url?: string;
    flow?: { flowId: string; cta: string };
  }

  // TODO(S2-01): replace this forward-declaration with the real SmartSendStrategist
  // from `strategist.ts` (RFC §4.4). Sprint 0 only needs the type to exist so
  // ClosedWindowStrategy's 'template' variant compiles.
  export interface SmartSendStrategist {
    decide(input: unknown): Promise<unknown>;
  }

  export type ClosedWindowStrategy =
    | { kind: 'template'; strategist: SmartSendStrategist }
    | { kind: 'message-tag'; tag: string }
    | { kind: 'none' };

  /** The only channel-specific code (RFC §4.12 / REQ-22). */
  export interface ChannelPolicy {
    readonly channel: string;
    readonly hasWindow: boolean;
    isWindowOpen(threadId: string): Promise<boolean>;
    readonly closedWindow: ClosedWindowStrategy;
    readonly consentRequired: boolean;
    renderInteractive(options: ChoiceOption[], prompt: string): InteractiveMessage;
    resolveInbound(m: InboundMessage): { input: string; selection?: ResolvedSelection };
  }
  ```
- `packages/kuralle-engagement/src/policies/web.ts`:
  ```ts
  import type { InboundMessage, InteractiveMessage } from '@kuralle-agents/messaging';
  import type { ResolvedSelection } from '@kuralle-agents/core';
  import type { ChannelPolicy, ChoiceOption } from '../policy.js';

  /** Web/SSE null policy — no window, no consent (RFC §4.12). Proves the abstraction. */
  export function webPolicy(): ChannelPolicy {
    return {
      channel: 'web',
      hasWindow: false,
      async isWindowOpen() { return true; },
      closedWindow: { kind: 'none' },
      consentRequired: false,
      renderInteractive(options: ChoiceOption[], prompt: string): InteractiveMessage {
        return {
          type: 'buttons',
          body: prompt,
          action: { type: 'buttons', buttons: options.map((o) => ({ id: o.id, title: o.label })) },
        };
      },
      resolveInbound(m: InboundMessage): { input: string; selection?: ResolvedSelection } {
        return { input: m.text ?? '' };
      },
    };
  }
  ```

**Modify:**
- `packages/kuralle-messaging/src/index.ts` — export `WindowStore`, `WindowState`, `InMemoryWindowStore` from `./adapter/window-store.js`.
- `packages/kuralle-engagement/src/index.ts` — `export * from './policy.js';` and `export { webPolicy } from './policies/web.js';` (replace the `export {}`).
- `packages/kuralle-engagement/package.json` — add `"@kuralle-agents/messaging": "workspace:*"` to `dependencies` (alongside `core`), then `bun install`. (Build order is fine: messaging is T2, engagement is T3.)

**Create tests:**
- `packages/kuralle-messaging/test/window-store.test.ts` — `window_store_fail_closed`: a fresh `InMemoryWindowStore`, `get('unknown-thread')` ⇒ `{ open:false, expiresAt:null }`; after `recordInbound(thread, now)`, `get(thread)` ⇒ `{ open:true }`; for an expiry in the past (`recordExpiry(thread, pastDate)`), `get` ⇒ `{ open:false, expiresAt: pastDate }`.
- `packages/kuralle-engagement/test/web-policy.test.ts` — `web_null_policy_always_open`: `webPolicy().hasWindow === false`; `await isWindowOpen('x') === true`; `consentRequired === false`; `closedWindow.kind === 'none'`; `renderInteractive([{id:'a',label:'A'}], 'pick')` returns a buttons `InteractiveMessage` with `action.buttons[0] === {id:'a',title:'A'}`.

**Do not touch:** `createMessagingRouter`, `stream-mapper`, the outbound pipeline (none exists yet — Sprint 1), `WindowTracker` internals, `core`. No router wiring.

---

## 4. Acceptance criteria (priority order)

1. `WindowStore`/`WindowState`/`InMemoryWindowStore` defined in `messaging` and exported from its index. (§4.9)
2. `InMemoryWindowStore.get` is **fail-closed**: an untracked thread ⇒ `{ open:false, expiresAt:null }` (never `open:true` on a miss). (§4.9/REQ-18)
3. `ChannelPolicy`, `ClosedWindowStrategy`, `ChoiceOption` defined in `engagement`; `SmartSendStrategist` forward-declared with the `TODO(S2-01)` marker. (§4.12)
4. `webPolicy()` returns the null adapter per §4.12 (no window, no consent, `closedWindow:{kind:'none'}`, always-open, buttons renderer, text `resolveInbound`).
5. `window_store_fail_closed` + `web_null_policy_always_open` pass.
6. `engagement` depends on `@kuralle-agents/messaging` (`workspace:*`); `bun install` clean.
7. `bun run build` + `bun run typecheck:all` green; `bun test packages/kuralle-messaging packages/kuralle-engagement` green.

---

## 5. Forward traps (note in your report; do NOT act on them now)

- `ChoiceOption` is defined in `engagement` here, but Sprint 3 (C1) adds `{type:'interactive'; …; options: ChoiceOption[]}` to **core's** `stream.ts`, which may require relocating `ChoiceOption` to core (core cannot import engagement). That is Sprint 3's problem — define it in engagement now, flag it.
- `SmartSendStrategist` is a placeholder (`decide(input: unknown): Promise<unknown>`). Sprint 2 (B1) replaces it with the real interface. Keep the `TODO(S2-01)` marker so it's grep-able.

---

## 6. What NOT to do

- No `createMessagingRouter` / pipeline wiring (Sprint 1).
- No real strategist, catalog, or selector (Sprint 2).
- No `withChoices` / interactive resolver chain (Sprint 3).
- Do not relocate `ChoiceOption` to core.
- No `@ts-ignore`, `--no-verify`, silent catch.

---

## 7. Validation contract (`.handoff/proof-s0-04.json`)

`assertions_required`:
- `REQ-18`
- `REQ-22`
- `test:window_store_fail_closed`
- `test:web_null_policy_always_open`
- `cmd:typecheck_all`

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| window-test | `bun test packages/kuralle-messaging/test/window-store.test.ts` | REQ-18, test:window_store_fail_closed |
| web-test | `bun test packages/kuralle-engagement/test/web-policy.test.ts` | REQ-22, test:web_null_policy_always_open |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

**Proof schema gotcha:** `claims[].type` ∈ `{test_suite, typecheck, lint, http, custom_command, ui_recording, file_exists}` exactly — no invented types (`test_suite` for `bun test`, `typecheck` for `typecheck:all`). Each `claims[]` entry needs: `id` (must equal the sidecar basename — claim `id:"window-test"` → sidecar `.handoff/proof-s0-04-window-test.stdout`), `stdout_sidecar` (that path), `command`, `cwd`, `exit_code`, `stdout_sha256` (sha256 of the sidecar), `satisfies_assertions`. Use the field name **`id`**, NOT `claim_id`. `assertions_satisfied == assertions_required`. Write sidecars + `.handoff/result-s0-04.done` (`DONE <sha> proof=.handoff/proof-s0-04.json`).

---

## 8. Demo artifact

`sprints/sprint-0/artifacts/s0-04-tests.txt` — passing both named tests + typecheck tail. Commit it.

---

## 9. Report back

Files changed, commit sha, proof slug `s0-04`, DoD ticked, demo path, one paragraph of trade-offs (esp. the two forward traps §5). No PR.

---

## 10. If stuck

- If `engagement` can't resolve `@kuralle-agents/messaging` / `@kuralle-agents/core` types: `bun install` then `bun run build` (rebuild their dist — engagement imports compiled dist, not src). Report if it persists.
- Baseline green pre-story; failures should trace to your change. No shortcuts.
