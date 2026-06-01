# Proceed Evidence — `S5-02` E2: broadcast engine + BroadcastLedger (R-07)

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S5-02` · **Commit:** `d0e3787` · **Slug:** `s5-02` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `engagement/src/{broadcast-ledger.ts, broadcast.ts}`, index, test. Scope matches brief.
- [x] **R-07 idempotency is ledger-based, not the effect log** — `send` loop: opted-in filter → `ledger.putIfAbsent(`${campaign}:${customer}`)` guard → `pipeline.send({kind:'template'})`. The test proves it decisively: 1st run `{sent:2}` (sink 2 calls); 2nd run **same ledger** `{sent:0, skipped:3}` (sink still 2 — no-op on retry); **fresh ledger** re-sends `{sent:2}` (sink 4 total). A fresh ledger re-sending confirms idempotency is the ledger, NOT the per-run effect log.
- [x] **Through the pipeline + opted-in only** — template sends traverse `pipeline.send` (gates apply); un-opted-in recipients skipped (`{sent:1, skipped:1}` test).
- [x] **`verify-handoff-proof.sh s5-02` → `PROOF_OK`** (3 claims, 4 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-12`, both named tests, `cmd:typecheck_all`).
- [x] **Independent verification:** `bun run build` exit 0; broadcast test **4 pass / 0 fail** (both named present); `bun test packages/kuralle-engagement` → **50 pass / 0 fail**; `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray notes.

**Verdict:** `PROCEED`

## One-line summary
`createBroadcasts` sends approved templates through the pipeline to opted-in recipients, idempotent across retry via `BroadcastLedger.putIfAbsent` (ledger-based, not effect-log — proven by same-vs-fresh-ledger test); reply enters flow via normal router · 50 eng tests green · proof `s5-02` · commit `d0e3787`.
