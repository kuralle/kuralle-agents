# Proceed Evidence — `S7-02` F2: multi-platform example (WA+web+IG)

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S7-02` · **Commit:** `1b4c22f` · **Slug:** `s7-02` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `examples/multi-platform/{server.ts (+153/−), README.md}` (wires `engagement({policies:[wa,web,ig]})` + `createMessagingRouter({...bridge})`), new `same-bot-across-channels.test.ts` (429 lines), `messaging-meta/package.json` (+example dep). Scope matches brief.
- [x] **`same_bot_across_channels` is genuinely cross-channel** — the same `ChoiceOption[]` renders per channel (WA list, IG carousel, web buttons) with **identical ids** (`waIds === igIds === webIds === sharedChoices.ids`); ≤3 options → buttons on all three with the same ids; inbound selection routes by id **identically** on WA and IG via the engagement resolver (`chain.resolve(waInbound) === chain.resolve(igInbound)`). One bot, no per-channel bot code.
- [x] **Example builds** — `typecheck:all` green (the example is swept).
- [x] **`verify-handoff-proof.sh s7-02` → `PROOF_OK`** (3 claims, 4 assertions) — first-try clean.
- [x] **Independent verification:** `bun run build` exit 0; `same-bot-across-channels.test.ts` → **6 pass / 0 fail**; `bun test {engagement,messaging,messaging-meta}` → **533 pass / 0 fail**; `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray notes.

**Verdict:** `PROCEED`

## One-line summary
The multi-platform example wires `engagement({policies:[wa,web,ig]})`; `same_bot_across_channels` proves one bot renders/routes the same `ChoiceOption` ids across WhatsApp + Instagram + web with no bot-code change · 533 tests green, example builds · proof `s7-02` · commit `1b4c22f`.
