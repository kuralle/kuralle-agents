# Story Brief — `S0-02` A0.1 Inbound types + customer identity (R-04/R-05)

> **You are the IC engineer (`cursor` worker — fresh process, clean context, no prior context).** Self-contained brief. Read it end-to-end before writing code. If anything is ambiguous or contradicts disk, **stop and ask**.
>
> **Atomic-commit policy:** when finished, commit atomically with `[S0-02] A0.1 inbound types + customer identity` on **`plan/whatsapp-engagement`** (confirm `git branch --show-current`). Do NOT push, do NOT touch `main`, one commit.
>
> **Runtime:** Bun. Tests run with `bun test`.

---

## 1. Goal

Extend the normalized inbound model so structured WhatsApp interactivity (template `button`, Flow `nfm_reply`) and a distinct **customer identity** survive into Kuralle, and fix the session resolver's double-prefix bug. Proven by two unit tests: `nfm_reply_and_template_button_parsed` and `session_id_not_double_prefixed`.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md` — sprint pointer + build branch.
2. `sprints/sprint-0/PLAN.md` § Story `S0-02` and § 0 (decisions).
3. RFC sections (the contract):
   - `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — **§4.10** (inbound type extensions), **§4.11** (default session resolver: `sessionId = threadId`, `userId = customerId`), **REQ-19** (customer identity distinct from session/thread; no `whatsapp:whatsapp:` double-prefix), **REQ-20** (structured selections must propagate).
   - `rfcs/whatsapp-engagement/04-tasks-validation.md` — **A0.1** chunk; **§9.1** tests `nfm_reply_and_template_button_parsed`, `session_id_not_double_prefixed`.
4. Source you will edit / mirror:
   - `packages/kuralle-messaging/src/types/messages.ts` — `InboundMessage`, `InteractiveReply`.
   - `packages/kuralle-messaging/src/adapter/session-resolver.ts` — the **bug**: `sessionId: \`${message.platform}:${message.threadId}\`` double-prefixes because `threadId` is already `whatsapp:{phoneNumberId}:{from}`.
   - `packages/kuralle-messaging-meta/src/webhook/normalizer.ts` — `NormalizedMessage` (lines 31-66). **`interactive` currently has NO `nfm_reply` field** (lines 54-58); `button?: { text; payload }` already exists (line 59).
   - `packages/kuralle-messaging-meta/src/whatsapp/client.ts` — `toInboundMessage` (~line 591).
   - `packages/kuralle-messaging-meta/src/messenger/client.ts` — `toInboundMessage` (~line 409).
   - `packages/kuralle-messaging-meta/src/instagram/client.ts` — `toInboundMessage` (~line 445).
   - Existing tests to mirror style + update: `packages/kuralle-messaging/test/session-resolver.test.ts`, `packages/kuralle-messaging-meta/test/whatsapp-client.test.ts`.

---

## 3. Files you will create or modify

**Modify (types):**
- `packages/kuralle-messaging/src/types/messages.ts`
  - `InteractiveReply`: add `formResponse?: Record<string, unknown>;`
  - `InboundMessage`: add `button?: { payload: string; text: string };` and `customerId: string;` (**required** — see §6 cascade note).
- `packages/kuralle-messaging-meta/src/webhook/normalizer.ts`
  - `NormalizedMessage.interactive`: add `nfm_reply?: { name?: string; response_json: string };` to the inline type (lines 54-58). The raw cast at ~line 304 (`normalized.interactive = msg.interactive as …`) already carries the data through; you are only adding it to the TYPE so `toInboundMessage` can read it without a cast.

**Modify (producers — every `toInboundMessage` must set `customerId`):**
- `packages/kuralle-messaging-meta/src/whatsapp/client.ts` `toInboundMessage`:
  - `customerId: msg.from` (the wa_id/phone).
  - `button: msg.button ? { payload: msg.button.payload, text: msg.button.text } : undefined`.
  - In the `interactive` object, add `formResponse: parseNfmReply(msg.interactive?.nfm_reply)` where `parseNfmReply` JSON-parses `response_json` **failure-safe** (try/catch → `undefined` on malformed JSON; a malformed payload must NOT throw and must NOT abort the message). Keep the existing `id`/`title`/`description` fields unchanged.
- `packages/kuralle-messaging-meta/src/messenger/client.ts` `toInboundMessage`: add `customerId: msg.from`. (No button/nfm_reply — Flows are WhatsApp-only.)
- `packages/kuralle-messaging-meta/src/instagram/client.ts` `toInboundMessage`: add `customerId: msg.from`. (Same — customerId only.)

**Modify (resolver fix):**
- `packages/kuralle-messaging/src/adapter/session-resolver.ts`:
  - `sessionId: message.threadId` (NO `${platform}:` prefix).
  - `userId: message.customerId ?? message.from.id`.
  - Update the doc comment to reflect the new format (the old comment describes the double-prefix rationale — replace it; threadId is already platform-scoped).

**Modify (tests — fixtures + new assertions):**
- `packages/kuralle-messaging/test/session-resolver.test.ts` — update to assert `sessionId === message.threadId` (not double-prefixed) and add the named test `session_id_not_double_prefixed` (a WhatsApp inbound with `threadId: 'whatsapp:PNID:15551234'` resolves to `sessionId: 'whatsapp:PNID:15551234'`, not `'whatsapp:whatsapp:PNID:15551234'`; `userId === customerId`).
- `packages/kuralle-messaging-meta/test/whatsapp-client.test.ts` — add `nfm_reply_and_template_button_parsed`: feed a normalized WA message with `interactive.nfm_reply.response_json` (valid JSON) and assert `toInboundMessage` output has `interactive.formResponse` deep-equal to the parsed object; feed a `button: { text, payload }` and assert `button.payload` is populated. Add a malformed-`response_json` case asserting `formResponse === undefined` (no throw).
- **Every existing test that constructs an `InboundMessage` object literal** must gain `customerId` to satisfy the now-required field (see §6). Files to check (grep `threadId:` / `platform:`): `packages/kuralle-messaging/test/{unhappy-paths,session-resolver-chain,session-resolver}.test.ts`, `packages/kuralle-messaging-meta/test/{whatsapp-client,messenger-client,instagram-client,base-client,unhappy-paths}.test.ts`. Set `customerId` to the same value as `from.id` in each fixture.

**Do not touch:** anything outside the above. No `core` edits. No RFC/WBS edits. No outbound-pipeline / router wiring (that is Sprint 1).

---

## 4. Acceptance criteria (priority order)

1. `InboundMessage` has required `customerId: string` and optional `button?: { payload; text }`; `InteractiveReply` has optional `formResponse?: Record<string, unknown>`. (§4.10)
2. WhatsApp `toInboundMessage` populates `customerId = msg.from`, `button` from `msg.button`, and `interactive.formResponse` from a **failure-safe** parse of `nfm_reply.response_json`. (§4.10)
3. Messenger + Instagram `toInboundMessage` set `customerId = msg.from`. (REQ-19 — required field; build must stay green.)
4. `defaultSessionResolver` returns `sessionId = message.threadId` (no double-prefix) and `userId = message.customerId ?? message.from.id`. (§4.11)
5. Test `session_id_not_double_prefixed` passes. (§9.1, R-05)
6. Test `nfm_reply_and_template_button_parsed` passes, incl. the malformed-JSON no-throw case. (§9.1, R-04)
7. `bun run build` + `bun run typecheck:all` green; `bun test` green across `kuralle-messaging` + `kuralle-messaging-meta` (no fixture left without `customerId`).

---

## 5. Codebase conventions

- ESM `.js` import specifiers (`from '../types.js'`). Match exactly.
- `toInboundMessage` is a `protected` template-method per client; return an object literal. Match the existing field order/style.
- Tests use `bun:test` (`import { test, expect } from 'bun:test'` or `describe`). Mirror the existing file you edit.
- No comments explaining *what*; only *why* if non-obvious (e.g. one line on why `formResponse` parse is failure-safe is acceptable).

---

## 6. Cascade note — `customerId` is REQUIRED (do not silently weaken)

Making `customerId` required (per §4.10 / REQ-19) means **every** `InboundMessage` producer and **every** test fixture literal must set it, or `typecheck:all` / `bun test` fails to compile. This is intentional — it enforces the identity invariant at compile time.

- Production producers: the 3 meta `toInboundMessage` methods (WA/Messenger/IG) — set in §3.
- Test fixtures: update all literals (grep `threadId:` under both test dirs).
- **Grep repo-wide** (`grep -rn "platform: '" packages/*/src packages/*/test` and `threadId:`) to be sure you caught every site. If you find an `InboundMessage` producer **outside `kuralle-messaging-meta`** (e.g. another package builds one), **STOP and report** before proceeding — that would be a wider blast radius than this story scoped, and the manager needs to decide. Do NOT make `customerId` optional to dodge the cascade.

---

## 7. What NOT to do

- Do not wire the resolver/inbound chain into `createMessagingRouter` (Sprint 3).
- Do not add the `InboundResolverChain` / `InteractiveResolver` (Sprint 3 — S0-02 only adds the *fields* they will later read).
- Do not refactor `toInboundMessage` beyond adding the new fields.
- Do not change `core`.
- No `@ts-ignore`, no `--no-verify`, no silent catch (the nfm_reply parse catch is explicit and returns `undefined` — that is not a silent swallow, it is the documented failure mode).

---

## 8. Validation contract (required in proof `.handoff/proof-s0-02.json`)

`validation_contract.assertions_required`:
- `REQ-19` — customer identity distinct; no double-prefix; userId = customerId
- `REQ-20` — structured selection fields present on InboundMessage
- `test:session_id_not_double_prefixed`
- `test:nfm_reply_and_template_button_parsed`
- `cmd:typecheck_all`

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| msg-tests | `bun test packages/kuralle-messaging/test/session-resolver.test.ts` | REQ-19, test:session_id_not_double_prefixed |
| meta-tests | `bun test packages/kuralle-messaging-meta/test/whatsapp-client.test.ts` | REQ-20, test:nfm_reply_and_template_button_parsed |
| meta-suite | `bun test packages/kuralle-messaging-meta` | REQ-19 (all fixtures compile with customerId) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

`assertions_satisfied` must equal `assertions_required`. Write stdout sidecars per claim and the `.handoff/result-s0-02.done` sentinel (`DONE <sha> proof=.handoff/proof-s0-02.json`).

**Proof schema gotcha (read this):** `claims[].type` MUST be one of exactly: `test_suite` | `typecheck` | `lint` | `http` | `custom_command` | `ui_recording` | `file_exists`. Do NOT invent values like `"build"`/`"shell"`/`"bun_test"` — the verifier rejects unknown types. Use `test_suite` for `bun test …`, `typecheck` for `typecheck:all`, `custom_command` for anything else. A `file_exists` claim uses a `path` field (not a `command`). Every command claim needs `command`, `cwd`, `exit_code`, `stdout_sha256` (of its sidecar), `satisfies_assertions`.

---

## 9. Demo artifact

`sprints/sprint-0/artifacts/s0-02-tests.txt` — captured `bun test` output for the two named tests passing + a `typecheck:all` tail. Commit it.

---

## 10. Report back

Files changed, commit sha, proof slug `s0-02`, DoD ticked, demo path, and one paragraph of trade-offs (esp. whether you found any out-of-scope `InboundMessage` producers). No PR — commit to the build branch; manager reviews.

---

## 11. If you get stuck

- A referenced symbol/path missing on disk → stop, report found-vs-expected.
- An `InboundMessage` producer outside `messaging-meta` → stop and report (see §6).
- Baseline was green before this story; a failure outside your files should trace to your change — diagnose, don't bypass.
