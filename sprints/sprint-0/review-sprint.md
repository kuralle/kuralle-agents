# Sprint 0 — Manager Review (Phase B, sandwich, r1)

**Reviewer:** Opus 4.8 (1M) · 2026-06-01 · **Build branch:** `plan/whatsapp-engagement`
**Scope:** full sprint diff `f2ef4cc..5aafa8f` (5 commits, 38 files, +947/-31), all 5 briefs, 5 proceed-evidence files, 5 proof JSONs.
**Whole-sprint gate:** `bun run typecheck:all` → exit 0; `bun test {core,messaging,messaging-meta,engagement}` → **794 pass / 0 fail / 84 files**.

---

## 1. Strengths (what's genuinely good)

- **Every story is surgical and additive.** No public-surface break: `HarnessStreamPart` unchanged (S0-05 reuses the existing `handoff` variant), `RunOptions`/`HarnessConfig`/`InboundMessage` extended with optional/new fields only, no `FlowNode` union change. `typecheck:all` proves no exhaustive-switch regression.
- **The leak-relevant invariants are real, not decorative.** `InMemoryWindowStore.get` fails **closed** on a store miss (`window-store.ts:23` → `{open:false, expiresAt:null}`) — the cold-process leak guard REQ-18 demands. `RunOptions.selection` merges `formData` into `runState.state` **before** the input block and persists (`openRun.ts:79-83`), so a durable replay re-applies the same shallow merge idempotently (R-03).
- **`parseNfmReply` is defensively correct** (`whatsapp/client.ts:764-779`): guards empty `response_json`, non-object, array, and `JSON.parse` throw → all `undefined`. A malformed Flow payload can never abort message normalization. This exceeded the brief (which only asked for "failure-safe").
- **Tests are behavioral, not shape-only.** `terminal-handoff.test.ts` drives the *full* escalate→`__escalate` signal→resume path and asserts: no missing-agent throw, `status==='paused'`, exactly **one** `handoff` part `{targetAgent:'human', reason}`, and a `done` part — plus a second test on the direct `{handoff:'human'}` path asserting `handoffHistory` is empty (proving no agent switch). `session_id_not_double_prefixed` asserts the concrete `whatsapp:{pnid}:{from}` shape.
- **Identity model lands as REQ-19 intends.** `customerId` is a *required* field (compile-time invariant), set by all three meta clients; the resolver yields `sessionId = threadId` (no `whatsapp:whatsapp:` double-prefix) and `userId = customerId ?? from.id`.
- **Forward seams are honestly marked.** `SmartSendStrategist` placeholder carries a grep-able `TODO(S2-01)` (`policy.ts:13`); `ChoiceOption` defined where the chunk scoped it. No silent debt.

## 2. Findings (file:line — severity — evidence — recommendation)

**Blockers:** none.
**Majors:** none.

**Minor:**

1. **`s0-02..s0-05-implementation-notes.md` at repo root — `minor` (cleanup).** Four files (`s0-02-implementation-notes.md`, …`s0-05`) committed to the **repo root**, in no brief's §3 file list and out of convention (S0-01 kept its notes in `.handoff`). They duplicate content already in `proceed-S0-*.md` + `.handoff/result-*.txt`. → **Apply now:** remove them in the fix pass (the proceed-evidence is the canonical manager record).

2. **Terminal-handoff double-emit — `minor` (documented, benign).** For an explicit `{handoff:'human'}` transition, `runFlow.ts:157` emits a `handoff` part *and* `Runtime.ts:179` now emits again; the test acknowledges this with `toBeGreaterThanOrEqual(1)`. Informational/idempotent; consumers ignore duplicates. → **No action this sprint.** If a consumer ever de-dupes on handoff parts, fold the emit into one site (Sprint 4 touches this path for the ownership gate — revisit there). Recorded in WARMDOWN.

3. **`ChoiceOption` lives in `engagement`, but Sprint 3 (C1) adds it to core `stream.ts` — `minor` (forward trap).** Core cannot import engagement, so Sprint 3 will likely relocate `ChoiceOption` to `@kuralle-agents/core` (as `ResolvedSelection` already is) and have engagement re-export. → **No action now;** flagged for the Sprint 3 brief.

## 3. Verdict

**READY — sprint closes.** No blockers, no majors. One `Apply now` minor (remove the 4 stray root notes files); the other two minors are documented forward-notes requiring no code change. RFC public surfaces (§4.8–4.12, REQ-19/20/22/23) match the diff — **no RFC amendment required this sprint** (the package-name resolution in PLAN §0 follows REQ-22 as written; not a divergence). Proceed to fix pass → warm-down.
