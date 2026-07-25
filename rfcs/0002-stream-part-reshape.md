# RFC 0002 — One stream union, audience in the type

**Status:** Ready to implement · **Date:** 2026-07-25 · **Author:** supervisor session
**Method:** `/diagnose` → `/zero-tech-debt` · **Supersedes:** the ad-hoc "merge the two unions" patch

---

## 1. The defect

`HarnessStreamPart` has two definitions, both publicly reachable from the same package:

| Import path | Definition | Variants |
|---|---|---|
| `@kuralle-agents/core` | `types/stream.ts` (`index.ts:386`) | 27 |
| `@kuralle-agents/core/types` | `types/voice.ts` (`types/index.ts:11`, via `export *`) | 58 |

The runtime's knowledge subsystem is typed against the 58-variant union and laundered into the
27-variant one by an explicit cast at `runtime/grounding/knowledge.ts:118`:

```ts
ctx.emit(event as HarnessStreamPart);
```

**Reproduced:** a `tsc` probe narrowing the public union on six runtime-emitted part types fails
6/6 with TS2367 "no overlap" — including `knowledge-cache-hit`, provably emitted at
`runtime/KnowledgeProvider.ts:159`.

This already shipped once. Commit `146d5b1` states it:

> knowledge-* observability events piggyback the harness stream via an explicit cast and are not in
> HarnessStreamPart's public union, so `tsc` flagged a no-overlap comparison (the test passed under
> `bun test`, which doesn't narrow literals, so it slipped past the pre-release gate).

That fix weakened the **test**. The split survived and the gate stayed blind.

## 2. Why merging the two unions is the wrong fix

The duplicate is an *event*. The structure that produced it is still there, and would reproduce it:

1. **`types/index.ts` is 16 × `export *`.** The public `/types` surface is whatever happens to land
   in those files. Nobody chose it. That is *how* a second `HarnessStreamPart` became publicly
   reachable — the duplicate was a consequence, not a cause.
2. **The audience distinction already exists — outside the type system.** `hono-server`'s
   `streamFilter.ts` keeps a hand-maintained `Set<string>` of client-safe part types, in a different
   package.
3. **A downstream package gave up on the union.** `shouldEmit(part: { type: string }, …)` — it does
   not use `HarnessStreamPart` at all.
4. **That Set has already drifted.** Three of its twelve entries (`text-clear`,
   `suggested-questions`, `input`) were never emitted by anything, verified across all packages at
   `HEAD` before the voice deletion.

Nothing owns *"what is an emitted part, and who is it for?"* — so variants accumulate wherever is
convenient, `export *` republishes them, and the filter drifts.

## 3. End state

> One `StreamPart` union with exactly one definition, where every variant **must** declare its
> audience in the type, and the public export surface is explicitly chosen.

```ts
// types/stream.ts — the only definition
export type StreamChannel = 'client' | 'internal';

interface StreamPartBase {
  /** Audience. The thing hono-server hand-maintains as a Set today. */
  channel: StreamChannel;
}

export type StreamPart =
  | (StreamPartBase & { type: 'text-delta';        payload: TextDeltaPayload })
  | (StreamPartBase & { type: 'knowledge-citation'; payload: KnowledgeCitationPayload })
  | (StreamPartBase & { type: 'knowledge-search';   payload: KnowledgeSearchPayload })
  | …

/** Classification is compulsory: a missing key is a compile error. */
export const PART_CHANNEL: Record<StreamPart['type'], StreamChannel> = { … };
```

**Envelope, not a union split** (revised after the peer review —
[`docs/peer-patterns-stream-and-composition.md`](../docs/peer-patterns-stream-and-composition.md)).
An earlier draft encoded audience by splitting into `ClientStreamPart | InternalStreamPart`. Mastra
(`BaseChunkType` + `ChunkFrom`) and LangGraph (`{seq, method, params}`) both put it on an **envelope
field** instead, which extends to a third audience without re-splitting the union — and gives
downstream filters a common shape to type against, which is precisely what `hono-server` lacked when
it fell back to `{ type: string }`.

The exhaustive `PART_CHANNEL` map is ours, not theirs: Mastra's `ChunkFrom` can be set wrong
silently, whereas a missing key here fails `tsc`. Envelope for extensibility, exhaustive map for
compulsion.

**Named payload interfaces** (`TextDeltaPayload`, …) are copied from Mastra — they keep a ~33-arm
union readable and make each payload independently referenceable in tests. Kuralle inlines all of
them today.

Four properties, each replacing a symptom above:

| Symptom | Structural fix |
|---|---|
| `export *` publishes accidental surface | explicit named re-exports in `types/index.ts` |
| audience lives in an untyped Set, elsewhere | `channel` field on the envelope, owned by core |
| the Set can drift from the union | exhaustive `PART_CHANNEL: Record<StreamPart['type'], StreamChannel>` |
| a misnamed file holds the shadow union | `voice.ts` dissolves into `types/knowledge.ts` |

`hono-server` imports `PART_CHANNEL` instead of maintaining its own list, and types against
`StreamPart` instead of `{ type: string }`.

## 4. Disposition of all 36 divergent variants — no "decide later"

| Disposition | Count | Basis |
|---|---|---|
| → `channel: 'client'` | 1 | `knowledge-citation` — emitted (`policies/agentTurn.ts:63`), already in the SAFE set |
| → `channel: 'internal'` | 5 | `knowledge-cache-hit`/`-cache-miss`/`-search`/`-quality-check`/`-reformulation` — emitted by `KnowledgeProvider`, consumed by `bench-ttft.ts` |
| **Deleted** | 27 | zero emit sites **and** zero consumers, incl. the 3 phantom SAFE entries |
| Not stream parts | 6 | belong to `ConversationAuditEntry` / `ConversationEvent`, different unions |

Chesterton's Fence was checked on the three phantom SAFE entries: never emitted by any package at
`HEAD`, including the (now-deleted) voice stack. No reason behind the fence.

## 5. Decisions taken

- **Rename `HarnessStreamPart` → `StreamPart`** in the same break. "Harness" is implementation
  history; the type is published at 0.x and this repo versions every package together, so one clean
  rename beats a deprecated alias (no band-aids). Called out in the changeset as breaking.
- **Observability events stay on the stream**, tagged `channel: 'internal'` — they are *not* moved to
  the `TraceStore`. `bench-ttft.ts` consumes `knowledge-search` off the stream, and `TraceRecorder`
  already builds spans by observing this same stream. The stream is the transport; the audience tag
  is the contract.
- **No compatibility shim.** The old shape fails all four real-caller tests: not persisted, not a
  wire format we don't own both sides of, not a documented contract, and every caller is inside this
  blast radius.

## 6. Blast radius (clear before cutting)

Reverse: `@kuralle-agents/skills` (imports `core/types`), `hono-server/streamFilter.ts`,
`cf-agent/StreamAdapter.ts`, `runtime/TraceRecorder.ts`, `ai-sdk/uiMessageStream.ts`,
`events/TurnHandle.ts`, `eval/simulation.ts`, `testing/mocks.ts`, `outcomes/streamPart.ts`,
`apps/playground/acme-support-agent/scripts/bench-ttft.ts`, `?format=raw` SSE consumers.
Forward: the two casts at `grounding/knowledge.ts:67,118` become unnecessary — their removal is the
proof the fix landed.

## 7. Work breakdown

Ordered by dependency. Each chunk ends green on `bun run typecheck:all` before the next starts, so
breakage surfaces one layer at a time.

| # | Chunk | Done when | Lane |
|---|---|---|---|
| 1 | Replace `export *` with explicit named re-exports in `types/index.ts` (16 lines) | `typecheck:all` green; `@kuralle-agents/core/types` surface is a diffable list | auto |
| 2 | Regression guard: test asserting exactly one definition of the stream union symbol in `core/src` | fails on a reintroduced duplicate | auto |
| 3 | Reshape `types/stream.ts` to envelope + named `*Payload` types; add the `channel` field; classify all 27 existing variants | `typecheck:all` green | **approve** |
| 4 | Add the exhaustive `PART_CHANNEL` map; prove a missing key is a compile error | deliberate omission fails `tsc` | auto |
| 5 | Move the 6 live knowledge variants in (1 client, 5 internal); delete both casts at `grounding/knowledge.ts:67,118` | casts gone, `typecheck:all` green | **approve** |
| 6 | Point `hono-server/streamFilter.ts` at `PART_CHANNEL`; type `shouldEmit` against `StreamPart` | its local `Set` deleted; hono-server tests green | approve |
| 7 | Delete `HarnessStreamPart` from `voice.ts`; repoint `outcomes/streamPart.ts` at `types/stream.ts` | one definition remains repo-wide | auto |
| 8 | Delete the 27 dead variants | `typecheck:all` green; no emit site or consumer lost | auto |
| 9 | Rename `types/voice.ts` → `types/knowledge.ts`; update the 7 importers | `typecheck:all` green | auto |
| 10 | Rename `HarnessStreamPart` → `StreamPart` repo-wide (39 files) | `typecheck:all` + full suite green | **full** — breaking public type |
| 11 | Restore the `flow-enter` assertion wrongly removed from `flow-triage.test.ts` | assertion present | auto |
| 12 | Promote the diagnosis probe into a permanent type test: every emitted part narrows from the public export | the seam `146d5b1` lacked now exists | auto |
| 13 | Changeset (breaking), `guides/` + `CHANGELOG` note on the audience split | `astro build` green | auto |

Chunks 3, 5 and 10 change public type surface. Chunk 10 is `full` lane — it is the breaking rename.

## 8. Validation contract

| # | Check | Gate |
|---|---|---|
| V1 | Public union narrows on every emitted part type (the 6 that failed diagnosis) | `tsc` in chunk 12's test |
| V2 | Adding a variant without listing it in `PART_CHANNEL` fails to compile | deliberate-omission test |
| V3 | Zero `as HarnessStreamPart` / `as StreamPart` casts remain in `packages/*/src` | `grep` = 0 |
| V4 | Exactly one definition of the stream union in `core/src` | chunk 2's guard |
| V5 | `hono-server` `safe` filter behaviour unchanged for the 9 still-live SAFE types | hono-server tests |
| V6 | `bench-ttft.ts` still sees `knowledge-search` / `knowledge-cache-hit` | script runs |
| V7 | Full gate | `bun run build`, `typecheck:all`, `bun run test` all exit 0 |

## 9. Follow-ups, named not bundled

- `types/index.ts`'s other 15 `export *` lines get the same treatment in chunk 1; if any turn out to
  publish more accidental surface, file it — do not widen this RFC.
- **`seq` + replay cursors** (LangGraph `StreamChannel`, Flue durable streams): our stream cannot be
  resumed from an offset. A real capability gap surfaced by the peer review — own RFC, not this one.
- **Provenance on the envelope** (`from` / `namespace`): needed the moment RFC 0001 subagents land.
  Own RFC.
- `audit/types.ts` and `foundation/ConversationEventLog.ts` carry variant names that collide with
  stream parts (`agent-start`, `tool-error`, `knowledge-citation`). Not a bug today — three separate
  unions with overlapping string literals — but worth a naming convention.
