# Story Brief — `S1-01` A1: OutboundSink + OutboundTemplate + capability detection

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end before coding. Ambiguity/contradiction with disk → **stop and ask**.
>
> **Atomic-commit:** finish → `[S1-01] A1 OutboundSink + capability detection` on **`plan/whatsapp-engagement`** (confirm `git branch --show-current`). No push, no `main`, one commit.
>
> **Runtime:** Bun. `bun test`.

---

## 1. Goal

Add the channel-neutral outbound capability surface to `@kuralle-agents/messaging`: `OutboundSink`, `OutboundTemplate`, and `isTemplateCapable`. No WhatsApp type leaks into `messaging`. Proven by `capability_detection`.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md`; `sprints/sprint-1/PLAN.md` § Story `S1-01` + § 0 (decisions — esp. `OutboundSink ≈ PlatformClient`, `OutboundTemplate` minimal this sprint, capability detection is a runtime guard).
2. RFC: `rfcs/whatsapp-engagement/02-requirements-interfaces.md` **§4.2** (OutboundSink/OutboundTemplate/`isTemplateCapable`); `04-tasks-validation.md` **A1**.
3. Source:
   - `packages/kuralle-messaging/src/types/client.ts` — `PlatformClient` already has `sendText(to:string,text:string):Promise<SendResult>`, `sendInteractive(to,msg):Promise<SendResult>`, `sendMedia(to,media):Promise<SendResult>`. `OutboundSink` is this minimal surface + optional `sendTemplate?`.
   - `packages/kuralle-messaging/src/types/responses.ts` — `SendResult`.
   - `packages/kuralle-messaging/src/types/messages.ts` — `InteractiveMessage`, `MediaPayload`.
   - `packages/kuralle-messaging/src/index.ts` — export your new types/fn here.
   - Test fixture pattern: `packages/kuralle-messaging/test/unhappy-paths.test.ts` (`createMockPlatform` — object-literal `PlatformClient` with recording sends).

---

## 3. Files you will create or modify

**Create:** `packages/kuralle-messaging/src/types/outbound.ts`:
```ts
import type { InteractiveMessage, MediaPayload } from './messages.js';
import type { SendResult } from './responses.js';
import type { PlatformClient } from './client.js';

/** A channel-neutral template payload (RFC §4.2). Component-aware enrichment (`components?`) is Sprint 2 (B2). */
export interface OutboundTemplate {
  name: string;
  language: string;
  namedParams?: Record<string, string>;
  positionalParams?: string[];
  raw?: unknown;
}

/** The channel-neutral send surface the OutboundPipeline terminates in (RFC §4.2). */
export interface OutboundSink {
  sendText(to: string, text: string): Promise<SendResult>;
  sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult>;
  sendMedia(to: string, media: MediaPayload): Promise<SendResult>;
  sendTemplate?(to: string, t: OutboundTemplate): Promise<SendResult>;
}

/** Capability detection — true when the client can send templates (window-agnostic payload). */
export function isTemplateCapable(
  c: PlatformClient,
): c is PlatformClient & Required<Pick<OutboundSink, 'sendTemplate'>> {
  return typeof (c as { sendTemplate?: unknown }).sendTemplate === 'function';
}
```

**Modify:** `packages/kuralle-messaging/src/index.ts` — export `OutboundSink`, `OutboundTemplate`, `isTemplateCapable` (types via `export type`, the fn via `export`).

**Create:** `packages/kuralle-messaging/test/outbound-sink.test.ts`.

**Do not touch:** `PlatformClient` (it already satisfies `OutboundSink` structurally — prove with a type assignment in the test, don't modify it). No pipeline yet (S1-02). No router/stream-mapper (S1-03). No `messaging-meta`.

---

## 4. Acceptance criteria (priority order)

1. `OutboundSink`, `OutboundTemplate`, `isTemplateCapable` exist in `types/outbound.ts` per §3 and are exported from the package index.
2. `isTemplateCapable` is a runtime `typeof … === 'function'` guard narrowing to a `sendTemplate`-bearing type.
3. A type-level assignment compiles: a `PlatformClient` is assignable to `OutboundSink` (the existing `sendText`/`sendInteractive`/`sendMedia` signatures match). Put this in the test file as a `const _sink: OutboundSink = somePlatformClient;` (or `satisfies`) to prove it.
4. **No WhatsApp type leak:** `grep -rn "messaging-meta" packages/kuralle-messaging/src` returns nothing (messaging must not import from messaging-meta).
5. Test `capability_detection`: a mock object with `sendTemplate: async () => …` → `isTemplateCapable` true; one without → false.
6. `bun run build` + `bun run typecheck:all` green; `bun test packages/kuralle-messaging` green (no regression).

---

## 5. What NOT to do

- No `OutboundPipeline`/middleware (S1-02), no `windowGuard`/router wiring (S1-03).
- Do not add `components?` to `OutboundTemplate` (Sprint 2 B2 — keep it minimal/neutral now).
- Do not modify `PlatformClient` or any `messaging-meta` client.
- No `@ts-ignore`, `--no-verify`, silent catch.

---

## 6. Validation contract (`.handoff/proof-s1-01.json`)

`assertions_required`:
- `REQ-17` (pipeline-surface foundation)
- `test:capability_detection`
- `cmd:no_meta_leak` (grep shows messaging/src does not import messaging-meta)
- `cmd:typecheck_all`

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| sink-test | `bun test packages/kuralle-messaging/test/outbound-sink.test.ts` | REQ-17, test:capability_detection |
| no-leak | `sh -c '! grep -rq "messaging-meta" packages/kuralle-messaging/src'` | cmd:no_meta_leak |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly — the verifier is strict)
- `claims[].type` ∈ **`test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`** — nothing else (no `"build"`, `"shell"`, `"bun_test"`).
  - `bun test …` → `test_suite`; `typecheck:all` → `typecheck`; the grep/`sh -c` → `custom_command`.
- Each claim needs: **`id`** (NOT `claim_id`) and it MUST equal the sidecar basename — claim `id:"sink-test"` → sidecar `.handoff/proof-s1-01-sink-test.stdout`; plus `stdout_sidecar` (that path), `command`, `cwd`, `exit_code`, `stdout_sha256` (sha256 of the sidecar), `satisfies_assertions`.
- Each `commands_run[]` row: `purpose` MUST be the literal `"verification"` (not free-text), and `claim_id` must match a `claims[].id`.
- `validation_contract.assertions_satisfied` MUST equal `assertions_required` (set equality).
- Write the sentinel: `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s1-01.json" > .handoff/result-s1-01.done`.

---

## 7. Demo artifact

`sprints/sprint-1/artifacts/s1-01-tests.txt` — passing `capability_detection` + typecheck tail. Commit it.

---

## 8. Report back

Files changed, commit sha, proof slug `s1-01`, DoD ticked, demo path, one paragraph of trade-offs. **Do NOT create a root `*-implementation-notes.md` file** (repo policy keeps such files local; put any notes in your report text). No PR.

---

## 9. If stuck

- Missing referenced symbol/path → stop, report found-vs-expected.
- Baseline is green pre-story (794 tests across the engagement packages). A failure should trace to your change. No shortcuts.
