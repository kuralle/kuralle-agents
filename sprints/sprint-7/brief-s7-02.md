# Story Brief — `S7-02` F2: multi-platform example (3 channels)

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S7-02] F2 multi-platform example (WA+web+IG)` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
Extend `packages/kuralle-messaging-meta/examples/multi-platform/server.ts` to wire `engagement({policies:[whatsappPolicy(...), webPolicy(), instagramPolicy(...)]})` and demonstrate the SAME agent/flow set on WhatsApp + web + Instagram, offline fake-client. Plus a `same_bot_across_channels` E2E. Proven by `same_bot_across_channels` + the example building.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-7/PLAN.md` § Story `S7-02` + § 0.
2. RFC `02-...` **§4.5** (`engagement().bridge` spreads into `createMessagingRouter`), `04-...` §9 (`same_bot_across_channels`); **REQ-22**.
3. Source:
   - `packages/kuralle-messaging-meta/examples/multi-platform/{server.ts, README.md, tsconfig.json}` — the existing example (read it fully; extend, don't rewrite from scratch).
   - `packages/kuralle-engagement/src/engagement.ts` (S7-01) — `engagement(opts)` → `{bridge, broadcasts}`.
   - `packages/kuralle-engagement/src/policies/{whatsapp,web,instagram}.ts` — the three policies.
   - `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` — spreads `...bridge`.
   - Test harness: `packages/kuralle-messaging/test/*` (`createMockPlatform`/`createMockRuntime`) or `packages/kuralle-e2e-tests/` for the E2E.

> `bun run build` first (S7-01 `engagement()` in dist).

## 3. Specs
- **Extend `server.ts`:** construct the three policies (WhatsApp with a mock/real client + selector; web; Instagram with a mock/real client) sharing a `windowStore`; `const eng = engagement({ policies:[whatsappPolicy(...), webPolicy(), instagramPolicy(...)], consent, ownership, audit })`; `const router = createMessagingRouter({ runtime, platforms:{ whatsapp, messenger?, instagram }, ...eng.bridge })`. The SAME `defineAgent`/flow set (one bot) is used — no per-channel branching in the bot.
  - Keep the example runnable offline (it should not require live Meta/AI creds to build/typecheck; gate any live calls behind env like the repo's other examples).
- **`same_bot_across_channels` E2E (offline fake-client):** drive an inbound from `whatsapp`, `web`, and `instagram` (mock platform clients recording sends) against ONE agent/flow with `withChoices`; assert each channel renders the choices per its policy (WA buttons/list, IG button-template/carousel, web buttons) with the SAME ids, and inbound id-routing is identical — with NO bot-code change between channels. Also assert window-safety per channel (closed-window WA→template/defer, IG→tag/defer, web→always sends).
- **README:** update the example README to describe the 3-channel wiring.

**Files:** `packages/kuralle-messaging-meta/examples/multi-platform/{server.ts, README.md}`; an E2E test (`packages/kuralle-engagement/test/same-bot-across-channels.test.ts` or under `kuralle-e2e-tests/`).

## 4. Acceptance criteria
1. `server.ts` wires `engagement({policies:[wa, web, ig]})` + `createMessagingRouter({..., ...eng.bridge})`; one agent/flow set, no per-channel bot code.
2. The example **builds** (`typecheck:all` sweeps it — confirm its tsconfig is in the sweep; if not, ensure it typechecks via the example tsconfig).
3. `same_bot_across_channels` E2E passes (offline fake-client): per-channel rendering of the same `ChoiceOption[]` by id; identical inbound id-routing; window-safety per channel.
4. `bun run build` + `typecheck:all` green; full suite green.

## 5. What NOT to do
- Don't require live Meta/AI creds to build/typecheck (gate live behind env).
- Don't fork the bot per channel — the whole point is ONE bot, N policies.
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s7-02.json`)
`assertions_required`: `REQ-22`, `test:same_bot_across_channels`, `cmd:example_builds`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| e2e-test | `bun test packages/kuralle-engagement/test/same-bot-across-channels.test.ts` | REQ-22, test:same_bot_across_channels |
| example-build | `bun run typecheck:all` | cmd:example_builds, cmd:typecheck_all |
| full-suite | `bun test packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` | REQ-22 (no regression) |

(If the E2E lives in `kuralle-e2e-tests/`, adjust the `bun test` path accordingly and note it.)

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only (`typecheck:all`→`typecheck`).
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s7-02-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s7-02.json" > .handoff/result-s7-02.done`.

## 7. Demo artifact
`sprints/sprint-7/artifacts/s7-02-tests.txt` — E2E + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s7-02`, DoD, demo, trade-offs (esp. how much of the example is offline-runnable vs env-gated; where the E2E lives). **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If the existing `server.ts` is a stub/minimal, extend it sensibly; flag if it references removed APIs.
- If the example tsconfig isn't in the `typecheck:all` sweep, note it (per the repo gotcha "playground/examples rot silently") and at least typecheck the example directly.
- Baseline green pre-story. No shortcuts.
