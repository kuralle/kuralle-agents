# Story Brief — `S3-03` C3: InboundResolverChain + InteractiveResolver + TextResolver + nfm_reply

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S3-03] C3 inbound resolver chain + nfm_reply routing` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
Replace the text-only `input = message.text ?? '[type]'` derivation in `createMessagingRouter` with an `InboundResolverChain` (`[InteractiveResolver, TextResolver]`) that maps inbound button/list/template-button/`nfm_reply` → a stable `id`/`formData`, routing the flow **by id (label-independent)** via `runtime.run({input, selection})` (S0-03). Free text → `TextResolver` → NLU. Proven by `interactive_routes_by_id_not_label`, `template_button_payload_routes`, `nfm_reply_form_in_state`, `free_text_nlu_fallback`.

## 2. Required reading
1. `sprints/sprint-3/PLAN.md` § Story `S3-03` + § 0.
2. RFC `02-...` **§4.3** (`InboundResolverChain`/`InteractiveResolver`/`TextResolver`/`ResolvedSelection`), **§4.8** (`RunOptions.selection`), **REQ-8/20**; `03-...` **§6.3** (resolution pseudocode).
3. Source:
   - `packages/kuralle-messaging/src/types/messages.ts` — `InboundMessage` (S0-02 fields: `interactive?: {id; ...; formResponse?}`, `button?: {payload; text}`, `text?`, `customerId`).
   - `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` — `const input = message.text ?? `[${message.type}]`` (the derivation to replace, ~line in onMessage); the `runtime.run({input, sessionId, userId})` call — add `selection`.
   - `packages/kuralle-messaging/src/types/adapter.ts` — `MessagingRouterConfig` (add `inputResolver?`); `SessionResolverChain` pattern for first-match-wins (`session-resolver-chain.ts`).
   - `@kuralle-agents/core` — `ResolvedSelection` (S0-03), `RunOptions.selection` (the runtime merges `selection.formData` into flow state + exposes `selection.id` as input).
   - `packages/kuralle-messaging/src/adapter/session-resolver-chain.ts` — mirror this chain style.

> `bun run build` first.

## 3. Specs
**Create `packages/kuralle-messaging/src/adapter/input-resolver-chain.ts`:**
```ts
import type { InboundMessage } from '../types/messages.js';
import type { ResolvedSelection } from '@kuralle-agents/core';

export interface InboundResolverPlugin {
  readonly name: string;
  tryResolve(m: InboundMessage): Promise<{ input: string; selection?: ResolvedSelection } | undefined>;
}

export class InteractiveResolver implements InboundResolverPlugin {
  readonly name = 'interactive';
  async tryResolve(m) {
    if (m.interactive?.id) return { input: m.interactive.id, selection: { id: m.interactive.id } };
    if (m.button?.payload) return { input: m.button.payload, selection: { id: m.button.payload } };
    if (m.interactive?.formResponse) return { input: '__flow__', selection: { formData: m.interactive.formResponse } };
    return undefined;   // defer to TextResolver
  }
}

export class TextResolver implements InboundResolverPlugin {
  readonly name = 'text';
  async tryResolve(m) { return { input: m.text ?? '', selection: undefined }; }  // catch-all
}

export class InboundResolverChain {
  constructor(private readonly plugins: InboundResolverPlugin[]) {
    if (plugins.length === 0) throw new Error('InboundResolverChain requires at least one plugin');
  }
  async resolve(m: InboundMessage): Promise<{ input: string; selection?: ResolvedSelection }> {
    for (const p of this.plugins) { const r = await p.tryResolve(m); if (r !== undefined) return r; }
    throw new Error('no inbound resolver matched');   // TextResolver is the catch-all, so unreachable in the default chain
  }
}
export const defaultInboundChain = () => new InboundResolverChain([new InteractiveResolver(), new TextResolver()]);
```
*(Confirm `m.interactive.id` is `''` when absent vs undefined — S0-02's `toInboundMessage` sets `id: '' ` when no button/list reply; guard with a truthy check so an empty id falls through to formResponse/text. Adjust the `m.interactive?.id` check to `m.interactive?.id` being a non-empty string.)*

**Modify `createMessagingRouter.ts`:** replace `const input = message.text ?? `[${message.type}]`` with:
```ts
const chain = config.inputResolver ? new InboundResolverChain(config.inputResolver) : defaultInboundChain();
const { input, selection } = await chain.resolve(message);
```
and pass `selection` into `runtime.run({ input, sessionId, userId, selection })`.

**Modify `types/adapter.ts`:** `MessagingRouterConfig` gains `inputResolver?: InboundResolverPlugin[]`.
**Modify `messaging/src/index.ts`:** export `InboundResolverChain`, `InteractiveResolver`, `TextResolver`, `InboundResolverPlugin`, `defaultInboundChain`.
**Create** `packages/kuralle-messaging/test/input-resolver-chain.test.ts`.

**Do not touch:** the stream variant/renderer (S3-01/02), `withChoices` (S3-04). Don't change `RunOptions`/openRun (S0-03 already did the propagation).

## 4. Acceptance criteria
1. Chain + resolvers per §3; empty chain throws; default chain `[InteractiveResolver, TextResolver]`.
2. `createMessagingRouter` uses the chain and passes `selection` to `runtime.run`.
3. `interactive_routes_by_id_not_label`: two inbound messages with the same `interactive.id` but different `title` resolve to the same `{input, selection:{id}}` (label-independent).
4. `template_button_payload_routes`: `button.payload` resolves to `{input: payload, selection:{id: payload}}`.
5. `nfm_reply_form_in_state`: `interactive.formResponse` resolves to `{input:'__flow__', selection:{formData}}`.
6. `free_text_nlu_fallback`: a plain-text message (no interactive/button) resolves via `TextResolver` to `{input: text}`.
7. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-messaging` green (existing router tests still pass — TextResolver preserves the text path; note the old `'[type]'` fallback becomes `''` for non-text-no-interactive — verify no test depended on `'[type]'`; if one does, update it and note).

## 5. What NOT to do
- Don't change the runtime/openRun selection merge (S0-03).
- Don't add the renderer or withChoices.
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s3-03.json`)
`assertions_required`: `REQ-8`, `REQ-20`, `test:interactive_routes_by_id_not_label`, `test:template_button_payload_routes`, `test:nfm_reply_form_in_state`, `test:free_text_nlu_fallback`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| resolver-test | `bun test packages/kuralle-messaging/test/input-resolver-chain.test.ts` | REQ-8, REQ-20, test:interactive_routes_by_id_not_label, test:template_button_payload_routes, test:nfm_reply_form_in_state, test:free_text_nlu_fallback |
| msg-suite | `bun test packages/kuralle-messaging` | REQ-8 (regression: router text path intact) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s3-03-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s3-03.json" > .handoff/result-s3-03.done`.

## 7. Demo artifact
`sprints/sprint-3/artifacts/s3-03-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s3-03`, DoD, demo, trade-offs (esp. the empty-id guard + whether any existing test relied on the `'[type]'` fallback). **No root `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If `m.interactive.id` is `''` for non-reply interactive messages, ensure your truthy check lets formResponse/text win. Test it.
- Baseline green pre-story. No shortcuts.
