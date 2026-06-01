# Story Brief — `S3-01` C1: interactive stream part + choice metadata + ChoiceOption relocation

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end. Ambiguity → **stop and ask**.
>
> **Atomic-commit:** `[S3-01] C1 interactive stream part + choice metadata` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

---

## 1. Goal

Add the **additive** `{type:'interactive'; nodeId; options: ChoiceOption[]; prompt}` variant to `core`'s authoritative `HarnessStreamPart`; relocate `ChoiceOption` to core; add optional `choices?` metadata to `CollectNode`/`DecideNode`; emit the interactive part on node entry. Prove the variant is additive (`typecheck:all` green; a consumer ignores the unknown variant).

---

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-3/PLAN.md` § Story `S3-01` + § 0 (esp. the two-unions trap + ChoiceOption relocation).
2. RFC `02-requirements-interfaces.md` **§4.6** (the variant), **§4.5** (`ChoiceOption` shape), **REQ-9** (additive, no `FlowNode` union break); `03-pseudocode-blueprint.md` **§6.4** (emit on node entry).
3. Source:
   - `packages/kuralle-core/src/types/stream.ts` — **authoritative** `HarnessStreamPart` (lines 3-18). Add the variant here.
   - `packages/kuralle-core/src/types/voice.ts:264` — a SEPARATE `HarnessStreamPart` union (voice path). **Do NOT touch it.** Your variant goes in stream.ts only; note the divergence in a doc-comment.
   - `packages/kuralle-core/src/types/selection.ts` — `ResolvedSelection` (S0-03). Put `ChoiceOption` here (or a new `interactive.ts`), exported the same way.
   - `packages/kuralle-core/src/types/flow.ts` — `CollectNode` (42-50), `DecideNode` (60-66); `collect()`/`decide()` factories (72-82). Add `choices?: ChoiceOption[]`.
   - `packages/kuralle-core/src/flow/runFlow.ts:141-142` — `ctx.emit({type:'flow-enter'...})` / `ctx.emit({type:'node-enter', nodeName: node.id})`. Emit the interactive part right after `node-enter` when the node has `choices`.
   - `packages/kuralle-core/src/index.ts` — export `ChoiceOption`.
   - `packages/kuralle-engagement/src/policy.ts` (`ChoiceOption` currently here, lines 8-14, used by `renderInteractive`), `packages/kuralle-engagement/src/policies/web.ts` (imports `ChoiceOption` from `../policy.js`).

> `bun run build` first.

---

## 3. Specs

**`core/src/types/selection.ts`** (or a new `core/src/types/interactive.ts`) — add `ChoiceOption` (the §4.5 shape, identical to engagement's current one):
```ts
export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  url?: string;
  flow?: { flowId: string; cta: string };
}
```
Export it from `core/src/index.ts` (and via `types/index.ts` re-export, same path `ResolvedSelection` uses).

**`core/src/types/stream.ts`** — add ONE variant to `HarnessStreamPart` (import `ChoiceOption`):
```ts
  | { type: 'interactive'; nodeId: string; options: ChoiceOption[]; prompt: string }
```
Add a doc-comment: this `stream.ts` union is authoritative for runtime emit; `types/voice.ts` has a separate voice union that intentionally does not carry this variant.

**`core/src/types/flow.ts`** — `CollectNode` and `DecideNode` each gain `choices?: ChoiceOption[];` (additive optional). The `collect()`/`decide()` factories already spread `...node`, so no factory change needed — verify.

**`core/src/flow/runFlow.ts`** — after `ctx.emit({type:'node-enter', nodeName: node.id})` (line 142), add:
```ts
if ((node.kind === 'collect' || node.kind === 'decide') && node.choices?.length) {
  ctx.emit({ type: 'interactive', nodeId: node.id, options: node.choices, prompt: <promptText> });
}
```
For `<promptText>`: derive a prompt string from the node — for `decide`, use `node.instructions` (resolve if it's a function/template to a string; if not trivially stringifiable, use `''` or the node id and document); for `collect`, use its `instructions(missing, state)` first-pass or `''`. Keep it simple and **document your choice** in the report. The prompt is best-effort display text; the routing is by id, so an empty prompt is acceptable if no clean source exists.

**`engagement/src/policy.ts`** — delete the local `ChoiceOption` interface; `import type { ChoiceOption } from '@kuralle-agents/core'` and re-export it (`export type { ChoiceOption } from '@kuralle-agents/core'`) so engagement authors still get it. `renderInteractive` signature unchanged.
**`engagement/src/policies/web.ts`** — import `ChoiceOption` from `@kuralle-agents/core` (or from `../policy.js` re-export). No behavior change.

**Tests** (`core/test/core-flow/interactive-stream-part.test.ts`):
- `interactive_part_is_additive`: construct each existing `HarnessStreamPart` variant + the new one; assert a `switch(part.type)` with a `default` compiles and handles the new variant via default (or an explicit case). The real proof is `typecheck:all` green — also assert at runtime that an existing consumer (e.g. a function that switches on known types with a default) returns a sane value for `{type:'interactive'}`.
- `interactive_emitted_on_node_entry`: a flow with a `decide`/`collect` carrying `choices` → run it and assert a `{type:'interactive', nodeId, options}` part is emitted (collect emitted parts via the TurnHandle events; reuse a core-flow test helper). Also assert a node WITHOUT `choices` emits NO interactive part.

**Do not touch:** `voice.ts`'s union; the renderer (S3-02); the inbound resolver (S3-03); `withChoices` (S3-04).

---

## 4. Acceptance criteria
1. `interactive` variant added to `stream.ts` `HarnessStreamPart`; doc-comment notes authority vs voice.ts.
2. `ChoiceOption` lives in core, exported from the package root; engagement imports/re-exports it (no shape change); `policy.ts` + `web.ts` updated.
3. `CollectNode`/`DecideNode` have optional `choices?`; factories unchanged for omitting callers.
4. `runFlow` emits the interactive part on entry to a collect/decide with `choices`; none when absent.
5. **Additive proven:** `typecheck:all` green; `interactive_part_is_additive` shows an existing default-switch consumer tolerates the variant.
6. `interactive_emitted_on_node_entry` passes.
7. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-core packages/kuralle-engagement` green.

## 5. What NOT to do
- Don't modify `voice.ts`'s `HarnessStreamPart`.
- Don't add a new `FlowNode` kind (choices is metadata on existing collect/decide — REQ-9).
- No renderer / resolver / withChoices (later stories).
- No `any`, `@ts-ignore`, `--no-verify`, silent catch. If the variant can't be added additively (an exhaustive switch with no default breaks), **STOP and report** (RFC §11 abort condition) — do not force it with suppression.

## 6. Validation contract (`.handoff/proof-s3-01.json`)
`assertions_required`: `REQ-9`, `test:interactive_part_is_additive`, `test:interactive_emitted_on_node_entry`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| int-test | `bun test packages/kuralle-core/test/core-flow/interactive-stream-part.test.ts` | REQ-9, test:interactive_part_is_additive, test:interactive_emitted_on_node_entry |
| core-suite | `bun test packages/kuralle-core` | REQ-9 (regression — no exhaustive-switch break) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s3-01-<id>.stdout`); plus `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose` = literal `"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied` == `assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s3-01.json" > .handoff/result-s3-01.done`.

## 7. Demo artifact
`sprints/sprint-3/artifacts/s3-01-tests.txt` — named tests + typecheck tail. **`git add` it** (commit the artifact — don't leave it untracked).

## 8. Report back
Files, commit sha, proof slug `s3-01`, DoD, demo path, trade-offs (esp. the `prompt` source you chose, and confirmation `typecheck:all` proves additivity). **No root `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If adding the variant breaks an exhaustive switch with no `default`, STOP and report (don't suppress) — that's the RFC §11 abort condition for this risk.
- Baseline green pre-story (826 tests). No shortcuts.
