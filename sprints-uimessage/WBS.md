# Work Breakdown Structure — AI-SDK-native `toUIMessageStream()`

> **The build plan, sprint by sprint.** Spans `docs/rfc-ai-sdk-native-uimessage-stream.md` — an **additive, non-breaking** adapter that maps Kuralle's `HarnessStreamPart` to a real AI SDK `UIMessageStream` (native text/tool parts + typed `data-kuralle-*` parts), so `useChat` consumers need zero bridge. `HarnessStreamPart` and the raw JSON-SSE wire are untouched. Successor to the streaming-by-default build (shipped 0.4.0/0.4.1); targets **0.5.0**.

---

## 1. Cadence and engineering practice

### 1.1 Cadence
- **1w sprints.** Planning at session start; Phase A (implementation) then Phase B (sprint-level review) within the session; warm-down at the end.
- **One sprint goal**, a single sentence with a verifiable outcome.
- **2–5 stories per sprint.** Each ships independently and is end-to-end demoable.
- **No carry-over.** Slipped stories return to the backlog, rewritten.

### 1.2 Definition of Done (universal)
1. Every story commits atomically (`[S{N}-{nn}] {title}`) on the **active build branch** (`plan/ai-sdk-native-uimessage` — see `STATE.md` § Build branch) with the full gate green: **`bun run typecheck:all`** + `bun run test`. (Note: `typecheck:all` is green as of 0.4.1 / B-06 fix — keep it green; no frozen-baseline exception this build.)
2. Unit tests for every new exported function / type. Behavioral coverage: ≥1 happy + ≥1 failure/edge path, using the offline patterns in `packages/kuralle-core/test`.
3. **Passes Phase-B manager review** (sandwich review on full diff + briefs + proceed artifacts); blockers/majors fixed.
4. **Public surfaces match the RFC.** Diffs to the RFC (the `data-kuralle-*` taxonomy, adapter signatures, `KuralleUIMessage` shape) require an explicit RFC amendment in `docs/rfc-ai-sdk-native-uimessage-stream.md` in the same sprint.
5. **AI SDK API names are verified against the installed `ai` version**, not memory — the SDK churns (esp. tool-part chunk names). Pin against `ai@^6` at implementation; cite the verified names in the proof.
6. Docs updated in the same change where they reference the stream output (READMEs, `apps/docs/`, `docs/skills/`). No feature ships without docs.
7. Demo artifact per story/sprint: an offline transcript or runnable invocation showing the emitted `UIMessageStream` chunks (not just a typecheck).
8. No `--no-verify`, no `@ts-ignore`/`as any`, no silent catch. **Additive only — `HarnessStreamPart`, `toResponseStream`, the cascaded voice path, and messaging MUST be unchanged** (REQ-7); a diff that touches them is out of scope unless the story says so.

### 1.3 Branching and commits
- **Build branch:** `plan/ai-sdk-native-uimessage`, cut from `main` (which holds 0.4.1) at the start of Sprint 0. All story + fix + closeout commits land here. Do not commit to `main` mid-sprint. Merge to `main` via a single PR after Sprint 4, paired with the `0.5.0` release.
- IC commits per-story atomically; manager commits fix-pass + closeout. Commit bodies end with the repo's `Co-Authored-By` trailer.

### 1.4 The review loop
**Phase A (IC + proceed evidence):** manager writes a story brief → fires `cursor` per story via `/delegate --mode impl` → IC commits + proof JSON. Run `/code-understand` before briefing unfamiliar surfaces (the SSE serializer `events/TurnHandle.ts`, the hono router `createAriaChatRouter`, the consumer `stream-bridge.ts`). After each story: diff + `verify-handoff-proof.sh` → `proceed-s{N}-{nn}.md`. **PROCEED** → next; **HOLD** → re-delegate IC.
**Phase B (manager review):** sandwich review → `review-sprint.md` (`REVIEW-r1.md` shape) → fix `[S{N}-fix]` → WARMDOWN + HANDOFF + STATE. `/delegate-review` **recommended on Sprint 1** (the adapter mapping is the correctness core) — optional elsewhere.

### 1.5 Warm-down
`sprint-N/WARMDOWN.md` (what shipped / open issues / decisions / RFC amendments) + `sprint-N/HANDOFF.md` (one-page read-me-first for the next session).

---

## 2. The roadmap

| Sprint | Phase | Goal (one sentence) |
|--------|-------|---------------------|
| 0 | Types & module | Ship `KuralleDataParts` + `KuralleUIMessage` types and the `ai-sdk/uiMessageStream.ts` module skeleton as additive, tested code — repo green, no behavior change, nothing wired. |
| 1 | The adapter | Implement `harnessToUIMessageStream` mapping every `HarnessStreamPart` variant (text→native, tool→native, Kuralle events→`data-kuralle-*` with correct transient/persistent flags) + `TurnHandle.toUIMessageStreamResponse()`, proven by a fixed-input → expected-chunks unit test. |
| 2 | Server integration | Add an opt-in UI-message mode to hono-server `createAriaChatRouter` (outbound `createUIMessageStreamResponse`, inbound `convertToModelMessages`), proven by an offline `useChat`-shaped round-trip. |
| 3 | Proof consumer (zero bridge) | Delete `stream-bridge.ts` in the `nextjs-chatbot` starter and drive it with `useChat` directly — streamed text + a `data-kuralle-*` part render with no bridge; `verify-templates.sh` green. |
| 4 | Polish + 0.5.0 | Land the docs + ADR-0005, a runnable native-stream example, and the unified `0.5.0` bump with a clean publish-together dry run. |

**RFC → sprint mapping:** Sprint 0 = RFC C1 (§4.1 types); Sprint 1 = C2+C3+C4 (§4.1/4.2 adapter + §6/§7 mapping); Sprint 2 = C5 (§4.3 hono + REQ-8/9); Sprint 3 = C6 (§5 proof consumer / REQ-1 success criterion); Sprint 4 = C7 (§5 docs + ADR-0005, §12 Q4 versioning).

---

## 3. Sprint detail

### Sprint 0 — Types & module
**Goal:** ship the `data-kuralle-*` part type map + `KuralleUIMessage` + the `ai-sdk/uiMessageStream.ts` module skeleton, additive and tested; repo green; nothing consumes it yet.

| Story | Description | DoD |
|-------|-------------|-----|
| S0-00 | Cut `plan/ai-sdk-native-uimessage` from `main`; baseline `build`/`test`/`typecheck:all` (expect all green per 0.4.1); record counts in `sprint-0/PLAN.md`. | Branch exists; baseline recorded honestly. |
| S0-01 | Add `KuralleMetadata`, `KuralleDataParts`, `KuralleUIMessage = UIMessage<KuralleMetadata, KuralleDataParts>` in `packages/kuralle-core/src/ai-sdk/uiMessageStream.ts`; export from the core index. Verify the `UIMessage` generic shape against installed `ai@^6`. | Types compile; `typecheck:all` green; a type-level test constructs each `data-kuralle-*` part. |
| S0-02 | Stub `harnessToUIMessageStream(source, opts)` returning an empty/passthrough `UIMessageStream` via `createUIMessageStream` (no mapping yet); confirm the `ai` imports resolve. | Module imports `createUIMessageStream` from `ai`; builds; a smoke test creates the stream and drains it (empty). |

**Source RFC §:** §4.1, C1. **Demo:** offline test — types construct + the stub stream drains; `typecheck:all` green.

### Sprint 1 — The adapter (the correctness core)
**Goal:** implement the full `HarnessStreamPart` → `UIMessageStream` mapping per RFC §4.2/§6/§7, proven by a fixed-input→expected-chunks test; add `TurnHandle.toUIMessageStreamResponse()`.

| Story | Description | DoD |
|-------|-------------|-----|
| S1-01 | Map the **text + control** variants: `text-start/delta/end` → native text chunks; `text-cancel` → close/abort the active text part; `error` → stream error; `done`/`turn-end` → finish/framing. | `uiMessageStream.modes` test: a fixed `HarnessStreamPart[]` with the text lifecycle yields native text chunks in order; cancel closes the part; error surfaces. |
| S1-02 | Map the **Kuralle events** to typed `data-kuralle-*` parts per the RFC §4.2 table, with correct flags: telemetry (`node-*`, `flow-*`, `interrupted`/`paused`, `custom`) `transient:true`; conversation-shaping (`interactive`, `handoff`, `safety-blocked`/`pipeline-validation-block`, `conversation-outcome`) persistent with stable `id`s. | Test asserts each event → the right `data-kuralle-*` type + `transient`/persistent + id; matches `KuralleDataParts`. |
| S1-03 | Map **tool** events: `tool-call`→native tool-input-available, `tool-result`→native tool-output-available. **Pin the exact v6 tool-part chunk names against installed `ai`** and cite them in the proof (RFC §12 Q2). Add `TurnHandle.toUIMessageStreamResponse(opts?)`. | Test: tool-call/result → native tool parts (names pinned + cited); `toUIMessageStreamResponse()` returns a `Response`. |

**Source RFC §:** §4.1–4.2, §6, §7 (C2/C3/C4); REQ-2/3/4/6. **Demo:** the full `uiMessageStream` test suite green showing native text + tool parts + `data-kuralle-*` parts for a representative turn. **`/delegate-review` recommended** (mapping correctness + the SDK-name pinning).

### Sprint 2 — Server integration
**Goal:** hono-server `createAriaChatRouter` gains an opt-in UI-message mode; a `useChat`-shaped client round-trips offline.

| Story | Description | DoD |
|-------|-------------|-----|
| S2-01 | Outbound: add a UI mode (`?format=ui` or a dedicated route) returning `createUIMessageStreamResponse({ stream: harnessToUIMessageStream(handle.events, {sessionId}) })`. Existing routes/formats unchanged. | Offline test hits the UI route, asserts the response is a UIMessageStream (native text + a `data-kuralle-*` part); the existing JSON-SSE route is byte-unchanged. |
| S2-02 | Inbound: accept `UIMessage[]` from `useChat` and convert via `convertToModelMessages` (REQ-9), replacing bespoke coercion on that path. | Test posts a `useChat`-shaped `UIMessage[]` body; asserts it converts and runs a turn; the legacy `{message, sessionId}` path still works. |

**Source RFC §:** §4.3, C5; REQ-8/9. **Demo:** an offline `useChat`-shaped POST → streamed UIMessage response captured under `sprint-2/`.

### Sprint 3 — Proof consumer (zero bridge)
**Goal:** the `nextjs-chatbot` starter consumes the agent via `useChat` with **no** `stream-bridge.ts`.

| Story | Description | DoD |
|-------|-------------|-----|
| S3-01 | In `kuralle-suite/kuralle-starters/nextjs-chatbot`: **delete `lib/kuralle/stream-bridge.ts`**, point the chat transport at the hono UI route, and let `useChat` render streamed text + surface a `data-kuralle-*` part (e.g. a `data-kuralle-safety` block) via `onData`/`message.parts`. | The template streams correctly with the bridge deleted; a `data-kuralle-*` part renders/handled; `verify-templates.sh` green. **(Cross-repo: this lands in the kuralle-starters repo, its own branch/commit.)** |

**Source RFC §:** §1 success criterion (zero bridge), §5 (C6). **Demo:** the template running with `stream-bridge.ts` gone; transcript under `sprint-3/`. **Note:** this story spans repos — the manager commits to `kuralle-starters` (its own branch), separate from the `aria-flow` build branch.

### Sprint 4 — Polish + 0.5.0
**Goal:** docs + ADR-0005 + a runnable native-stream example + the unified `0.5.0` bump with a clean publish dry run.

| Story | Description | DoD |
|-------|-------------|-----|
| S4-01 | Runnable example under `packages/kuralle-core/examples/` printing the emitted `UIMessageStream` chunks for an ungated turn (native text + a `data-kuralle-*` part). Run it live (not just typecheck). | Example runs; output captured. |
| S4-02 | Docs: `apps/docs/`, READMEs, `docs/skills/` for the native path + the `data-kuralle-*` taxonomy; write `docs/adr/0005-ai-sdk-native-uimessage-stream.md`. | Docs reference the native adapter + the data-part map; ADR-0005 present; no doc points at a hand-rolled bridge as the recommended path. |
| S4-03 | Unified `0.5.0` bump across all packages (manual-version per the 0.x+`workspace:*` gotcha), CHANGELOG (additive: new `toUIMessageStream` capability), `pnpm publish -r` **dry run** clean. | All `package.json` at `0.5.0`; CHANGELOG entry; dry-run clean. (Real publish per the human/owner decision, as with 0.4.x.) |

**Source RFC §:** §5 (C7), §12 Q4. **Demo:** live example output + rendered ADR-0005 + clean `pnpm publish -r --dry-run`.

---

## 4. Backlog (deferred)

| ID | Item | Earliest | Source RFC § |
|----|------|----------|--------------|
| BU-01 | Extract the adapter into a thin `@kuralle-agents/ai-sdk` package if `core` should shed UI concerns. | post-0.5.0 | §12 Q1 |
| BU-02 | Deprecate (not remove) the per-consumer hand-rolled bridge pattern in docs once the native path is proven. | post-0.5.0 | §10 |
| BU-03 | Voice-transcript → UIMessageStream (native realtime transcripts to a web UI) — separate RFC. | future | §12 Q5 |
| BU-04 | Studio `SSEChatTransport` migration to the native path (separate repo) — the original motivation. | downstream | §1 |

---

## 5. Risks tracked across sprints

| Risk | Sprint(s) | Owner | Mitigation |
|------|-----------|-------|------------|
| AI SDK tool-part / chunk names drift between `ai` versions | 1 | Manager | Pin names against installed `ai@^6` at S1-03; cite verified names in proof; `/delegate-review` on Sprint 1 |
| Adapter mis-flags transient vs persistent (telemetry leaks into history, or a safety block isn't persisted) | 1 | Manager | RFC §4.2 table is the contract; test asserts the flag per event |
| The change accidentally touches `HarnessStreamPart`/`toResponseStream`/voice (REQ-7 additive-only) | all | Manager | DoD §8 additive-only gate; proceed-evidence checks the diff scope |
| Cross-repo Sprint 3 (kuralle-starters) coordination | 3 | Manager | treat as its own repo/branch; the aria-flow build doesn't depend on it landing to close |
| `convertToModelMessages` inbound shape mismatch with `useChat` v6 | 2 | Manager | verify against installed `ai@^6`; offline round-trip test |

---

## 6. The role of this document
This WBS is the *plan*. The driver is [`./SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md); the current pointer is [`./STATE.md`](./STATE.md); templates under [`./templates/`](./templates/). When this WBS conflicts with the source RFC, **the RFC (`docs/rfc-ai-sdk-native-uimessage-stream.md`) wins** — amend this doc in the same PR.
