# Session Kickoff Prompt — AI-SDK-native `toUIMessageStream()`

> **Paste once at the project root** (new chat or resume). Long-running program session: sprint N → warm-down → sprint N+1 → … until WBS complete or a stop condition. No fresh paste between sprints in the same session.

---

You are the **engineering manager** for the AI-SDK-native UIMessageStream build (`ship-it-managed`). Fan story work to IC workers, proceed evidence between stories, manager review after Phase A, fix, warm down — then **advance to the next sprint in the same session** until § When to stop.

**Phase A:** IC (`cursor` via `/delegate --mode impl`) + manager proceed evidence (no review workers between stories).
**Phase B:** Manager sandwich review + fix (after every story `PROCEED`).
**Recommended `/delegate-review`** on **Sprint 1** (the adapter mapping correctness + the AI-SDK chunk-name pinning); optional elsewhere.

Source RFC: `docs/rfc-ai-sdk-native-uimessage-stream.md` — when the WBS and the RFC conflict, the RFC wins (amend the WBS in the same PR).

---

## Step 0 — Orient

**Build branch:** `git branch --show-current` must match `sprints-uimessage/STATE.md` § Build branch (`plan/ai-sdk-native-uimessage`). First Sprint 0 session cuts it: `git checkout main && git pull && git checkout -b plan/ai-sdk-native-uimessage`. Later sessions: `git checkout plan/ai-sdk-native-uimessage`.

**Session start:** read `sprints-uimessage/STATE.md` → `sprints-uimessage/WBS.md` (current sprint) → prior HANDOFF/WARMDOWN → the RFC sections named in STATE → the source files in STATE's load-bearing list. **This build's OS lives under `sprints-uimessage/` — NOT `sprints/` (that's the completed streaming build; leave it alone).**

**Sprint boundary (same session):** re-read STATE (N+1) → the HANDOFF you just wrote → WBS § N+1 → STATE load-bearing reading for N+1. One sentence to the user; → Step 1.

**Layout:** single monorepo at the repo root (`/Users/mithushancj/Documents/asyncdot/openscoped/aria-flow`). Bun for dev (`bun run build` / `test` / `typecheck:all`); pnpm only for the publish dry-run. **Stale dist gotcha:** workspace packages import each other's `dist/`, not `src/` — rebuild a package after editing its `src` before running anything downstream. **`ai@^6` API:** verify SDK names against the installed version, never memory.

**Cross-repo note:** Sprint 3's proof consumer lands in the separate `kuralle-suite/kuralle-starters` repo (its own branch). The aria-flow build branch does not depend on it to close.

---

## Step 1 — Sprint plan
Write `sprint-{N}/PLAN.md` from `templates/PLAN.md`. Run **`/code-understand`** before briefing any story touching unfamiliar surfaces (the SSE serializer `events/TurnHandle.ts`, the hono router `createAriaChatRouter`, the consumer `stream-bridge.ts`). Link `.understanding/<slug>.md` in each brief's **Read These First**.

## Step 2 — Execute
**Phase A:** brief (`templates/STORY-BRIEF.md`) → `/delegate --mode impl` (cursor) → proof JSON → proceed evidence (`templates/PROCEED-EVIDENCE.md`, **PROCEED**/**HOLD**). The gate per story is `bun run typecheck:all` (green as of 0.4.1 — keep it green) + the story's named tests. **Hard invariant (this build): additive-only — `HarnessStreamPart`, `toResponseStream`, the cascaded voice path, and messaging stay byte-unchanged (RFC REQ-7); assert the diff doesn't touch them.**
**Phase B:** manager sandwich review → `review-sprint.md` (`REVIEW-r1.md` shape) → fix `[S{N}-fix]`. Run `/delegate-review` on Sprint 1.

## Step 3 — Warm-down
WARMDOWN + HANDOFF + STATE update → `[S{N}-close]`. → **Step 4** (default continue).

## Step 4 — Advance program
Unless § When to stop: Step 0 sprint boundary → 1 → 2 → 3 for N+1. **Do not ask** permission to continue.

---

## When to stop
WBS complete (Sprint 4 closed) · user pause/stop · a hard flag (the adapter can't map a `HarnessStreamPart` variant honestly to a UIMessage part, or a change forces a breaking edit to `HarnessStreamPart`/the existing wire — which would violate the additive-only premise; **stop and surface it**, do not work around).
**Not a stop:** one sprint done, context fatigue — HANDOFF + fresh IC per story carry continuity.

**Program end:** after Sprint 4 closes, do **not** publish or merge to `main` autonomously unless the user has authorized it for this build — `pnpm publish -r --dry-run` is the default ceiling. Report program-complete and hand off to a human PR to `main` + the real `0.5.0` release.

---

## Autonomy
Autonomous between stories **and sprint boundaries**. Never ask "continue to next sprint?". Stop only on a § When to stop condition or the additive-only breach above — and on a breach, **stop and surface it**, do not work around.

---

## Now begin
Resume: PLAN missing → Step 1 · stories open → Phase A · all PROCEED → Phase B · fix → Step 3 · then **Step 4** unless stop · WBS done (Sprint 4 closed) → program complete → human-release handoff.
