# Story Brief — `S3-04` C4: withChoices author helper + end-to-end

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S3-04] C4 withChoices + interactive end-to-end` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
`withChoices(node, options)` attaches `choices` metadata to a `collect`/`decide` node; plus an end-to-end fake-client test stitching S3-01..03 (choices emit → renderer → buttons; inbound id routes the flow; a Flow submission lands `formData` in state). Proven by `withchoices_attaches`, `interactive_end_to_end`.

## 2. Required reading
1. `sprints/sprint-3/PLAN.md` § Story `S3-04` + § 0.
2. RFC `02-...` **§4.5** (`withChoices` signature), **§6.3/§6.4**; **REQ-7/8**.
3. Source:
   - `packages/kuralle-core/src/types/flow.ts` — `CollectNode`/`DecideNode` (now have optional `choices?`, S3-01); `ChoiceOption` (core, S3-01).
   - `packages/kuralle-engagement/src/interactive-renderer.ts` (S3-02), `packages/kuralle-messaging/src/adapter/input-resolver-chain.ts` (S3-03), `packages/kuralle-engagement/src/strategist-middleware.ts` (pattern for an engagement middleware), `webPolicy` (renderInteractive).
   - Test patterns: `packages/kuralle-engagement/test/*` + a core-flow run helper for driving a flow with a fake model/driver (see `packages/kuralle-core/test/core-flow/terminal-handoff.test.ts` for the runtime+driver+events pattern).

> `bun run build` first (S3-01/02/03 all in dist).

## 3. Specs
**Create `packages/kuralle-engagement/src/authoring.ts`:**
```ts
import type { ChoiceOption } from '@kuralle-agents/core';
// CollectNode | DecideNode types from core
export function withChoices<N extends CollectNode | DecideNode>(node: N, options: ChoiceOption[]): N {
  return { ...node, choices: options };
}
```
(Import `CollectNode`/`DecideNode` from `@kuralle-agents/core`. If they aren't exported from the core root, export them in S3-04 — additive — or import via the published type path; confirm and use the exported names.)

**Modify** `engagement/src/index.ts` — export `withChoices`.
**Create** `engagement/test/interactive-e2e.test.ts`.

**Tests:**
- `withchoices_attaches`: `withChoices(decide({...}), [{id:'a',label:'A'}])` returns a node with `choices` set, kind preserved (`'decide'`).
- `interactive_end_to_end` (fake-client, offline): drive a flow with a `decide` that has `withChoices([...3 options])`; assert (a) the runtime emits a `{type:'interactive'}` part on node entry (S3-01); (b) running those parts through a pipeline `[interactiveRenderer(), windowGuard]` (window open) produces an `{kind:'interactive'}` send to a recording sink with 3 buttons (S3-02); (c) an inbound `interactive.button_reply{id:'a', title:<anything>}` resolved by the chain (S3-03) yields `{input:'a', selection:{id:'a'}}` — i.e. routes by id regardless of label; (d) an inbound with `interactive.formResponse` yields `{selection:{formData}}`. You may assert these as composed unit steps (emit → render → resolve) rather than a full live runtime turn if a full turn needs a real model — keep it offline/deterministic and document the seams you exercised.

**Do not touch:** the stream variant/renderer/resolver internals (S3-01/02/03) — only compose them + add `withChoices`.

## 4. Acceptance criteria
1. `withChoices(node, options)` attaches `choices`, preserves node kind/type; works for both `collect` and `decide`.
2. `interactive_end_to_end` exercises emit → render(3 buttons) → inbound-id-routing (label-independent) → formResponse→formData, all offline.
3. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-engagement packages/kuralle-messaging packages/kuralle-core` green.

## 5. What NOT to do
- Don't reimplement the renderer/resolver — compose them.
- No new FlowNode kind.
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s3-04.json`)
`assertions_required`: `REQ-7`, `REQ-8`, `test:withchoices_attaches`, `test:interactive_end_to_end`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| e2e-test | `bun test packages/kuralle-engagement/test/interactive-e2e.test.ts` | REQ-7, REQ-8, test:withchoices_attaches, test:interactive_end_to_end |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-7 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s3-04-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s3-04.json" > .handoff/result-s3-04.done`.

## 7. Demo artifact
`sprints/sprint-3/artifacts/s3-04-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s3-04`, DoD, demo, trade-offs (esp. how much of the e2e you drove as a live runtime turn vs composed seams). **No root `*-implementation-notes.md`.** No PR.

## 9. If stuck
- `CollectNode`/`DecideNode` not exported from core root → export them (additive) and note it.
- Baseline green pre-story. No shortcuts.
