# Proceed Evidence — `S3-03` C3: InboundResolverChain + nfm_reply routing

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S3-03` · **Commit:** `83a4215` · **Slug:** `s3-03` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `adapter/input-resolver-chain.ts` (new: chain + `InteractiveResolver` + `TextResolver`), `createMessagingRouter.ts` (uses `defaultInboundChain`/`config.inputResolver`, passes `selection` into `runtime.run`), `types/adapter.ts` (`inputResolver?`), `index.ts`, test. Scope matches brief.
- [x] **Stable-id routing** — `InteractiveResolver` maps `interactive.id`/`button.payload`→`{id}`, `formResponse`→`{formData}`; `TextResolver` catch-all. Router passes `{input, selection}` to `runtime.run` (S0-03 merges formData into flow state, exposes id as input).
- [x] **`verify-handoff-proof.sh s3-03` → `PROOF_OK`** (3 claims, 7 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-8`, `REQ-20`, all 4 named tests, `cmd:typecheck_all`).
- [x] **Independent verification:** `bun run build` exit 0; resolver test **11 pass / 0 fail** (all 4 named present: routes_by_id_not_label, template_button_payload_routes, nfm_reply_form_in_state, free_text_nlu_fallback); full `bun test packages/kuralle-messaging` → **444 pass / 0 fail** (the `input = message.text ?? '[type]'` → resolver-chain change introduced **no regression**); `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray root notes.

**Verdict:** `PROCEED`

## One-line summary
`InboundResolverChain` ([InteractiveResolver, TextResolver]) routes button/list/template-button/`nfm_reply` by stable id (label-independent) + free-text NLU fallback; router passes `selection` to `runtime.run` · 444 messaging tests green · proof `s3-03` · commit `83a4215`.

## Notes
- The `'[type]'` fallback derivation is replaced; `TextResolver` (catch-all) preserves the text path — full messaging suite green confirms no consumer depended on `'[type]'`.
- Label-independence proven: same `interactive.id` with different `title` → identical `{input, selection}` (`interactive_routes_by_id_not_label`).
