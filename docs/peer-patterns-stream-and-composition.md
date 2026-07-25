# Peer patterns — LangGraph.js, DeepAgents.js, Mastra

**Date:** 2026-07-25 · **Question:** what do these three do that kuralle should do better?
**Method:** source read of cloned repos (`langchain-ai/langgraphjs`, `langchain-ai/deepagentsjs`,
`mastra-ai/mastra`), targeted at kuralle's open problems: stream typing (RFC 0002), agent definition
(RFC 0001), delegation, and durability.

---

## 1. The headline: kuralle is the only one without a stream envelope

All three model an emitted event as **envelope + typed payload**. Kuralle inlines every field into
every union arm and carries no envelope at all.

| | Envelope | Provenance | Discriminator | Payload |
|---|---|---|---|---|
| **LangGraph** | `{ type:'event', seq, method, params }` | `params.namespace: string[]` — hierarchical agent-tree path | `method` = channel, **open** (`StreamMode \| 'lifecycle' \| 'input' \| (string & {})`) | `params.data`, per-channel |
| **Mastra** | `BaseChunkType & { type, payload }` | `runId` + `from: ChunkFrom` (`AGENT`/`USER`/`SYSTEM`/`WORKFLOW`/`NETWORK`) | `type` (54 arms) | named `*Payload` interfaces |
| **DeepAgents** | inherits LangGraph's | inherits | inherits | inherits |
| **kuralle** | **none** | **none** | `type` (27 public / 58 internal) | inlined object literals |

Three consequences for us, each already observed as a bug:

1. **Nothing common to filter on.** `hono-server/streamFilter.ts` takes `part: { type: string }` — it
   gave up on the union because there is no shared shape to type against. Both peers give a filter
   the envelope, so filtering is typed. LangGraph goes further: `MatchableEvent` is a deliberately
   *minimal structural* contract so "the same predicate works on in-process fan-out, buffered
   replay, and server-side SSE filtering without coupling to a single event type."
2. **Every variant re-declares its own shape.** That is why a second 58-arm union could grow in
   `voice.ts` without anyone noticing — there was no common surface to violate.
3. **No provenance.** Kuralle has handoffs and (in RFC 0001) subagents, yet a `text-delta` carries no
   indication of *which* agent emitted it. Both peers put this in the envelope.

### What this changes in RFC 0002

My proposed `ClientStreamPart | InternalStreamPart` split is a real structural fix but the wrong
shape: it encodes audience by **splitting the union**, so a third audience means re-splitting. Mastra
encodes the same idea as a **field on the envelope** (`ChunkFrom`), which extends without a split.

Revised target:

```ts
interface StreamPartBase {
  channel: 'client' | 'internal';   // audience — the thing hono-server hand-maintains today
}
export type StreamPart =
  | (StreamPartBase & { type: 'text-delta'; payload: TextDeltaPayload })
  | (StreamPartBase & { type: 'knowledge-search'; payload: KnowledgeSearchPayload })
  | …
```

Keep the exhaustive `Record<StreamPart['type'], Channel>` map from RFC 0002 §3 — that is the part
neither peer has, and it is what makes classification *compulsory* rather than conventional. Mastra's
`ChunkFrom` can be set wrong silently; an exhaustive map cannot be omitted.

**Named payload interfaces** (Mastra's `TextDeltaPayload`, `ToolCallPayload`, …) are worth copying
outright: they keep a 50-arm union readable and make each payload independently referenceable in
tests. Kuralle inlines all of them.

### Two capability gaps, flagged not bundled

- **`seq` (LangGraph).** A monotonic sequence number per run, for "ordering and deduplication",
  driving `since` **replay cursors** over an append-only `StreamChannel` ("independent replay
  cursors"). Kuralle's stream cannot be resumed from an offset. Flue ships the same idea (durable
  streams "replayed from any offset"). This is a real gap — but it is a *capability*, separate from
  RFC 0002's ambiguity fix. Own RFC.
- **`namespace` / `from` provenance.** Needed the moment RFC 0001's subagents land. Own RFC.

---

## 2. DeepAgents: one composition mechanism, not three

`createDeepAgent` composes everything as **middleware** with documented deterministic ordering
(`mergeMiddlewareStack`, `resolveMiddleware`): filesystem, subagents, summarization, memory, skills,
caching, HITL, tool-exclusion, patch-tool-calls, async-subagents.

Kuralle has **three** parallel mechanisms for the same job:

| kuralle | what it does | deepagents equivalent |
|---|---|---|
| `capabilities` (`refine[]` / `validate[]`) | pre/post-turn policies | middleware |
| `processors` (input/output) | stream/message transforms | middleware |
| `hooks` (the 5-method `Hooks`, `types/hooks.ts`) | project lifecycle observation | middleware |

Three mechanisms means three places to look and three orderings to reason about. DeepAgents answers
"what runs between the user's message and the model call?" with one ordered list.

**Resolved by ADR-0015** (`docs/adr/0015-turn-composition.md`): keep the three distinct, with one
*fixed* pipeline order — input processors → refinement → gather + execute → output processors →
validation. The DeepAgents single stack was rejected deliberately: its stages are homogeneous
middleware, whereas ours differ in authority over durable state and output release, so a
user-orderable list would turn security redaction and persistence ordering into a convention.
RFC 0001 therefore exposes one agent-level `policies.ts`, not three files; project `hooks.ts` stays
separate because it configures `HarnessConfig.hooks`, not an `AgentConfig`.

The lesson stands even though we declined the shape: the 3-way split is now a **decision**, not an
accident — which was the actual defect.

## 3. DeepAgents: layered skill sources, last-one-wins

```ts
sources: [
  "/skills/user/",      // parent dir: every subdir with SKILL.md
  "/skills/project/",   // …
  "/skills/my-skill/",  // direct path: SKILL.md at this dir's root
]
```

> "Sources are loaded in order, with later sources overriding earlier ones when skills have the same
> name (last one wins). This enables layering: base -> user -> project -> team skills."

Kuralle now follows this pattern: `fsSkillStore(fs, roots)` loads roots in order and later roots
override earlier skills with the same frontmatter `name`. RFC 0001 can layer a project's
`agents/<id>/skills/` over shared defaults without copying files.

Also worth copying: the middleware "uses backend APIs exclusively (no direct filesystem access),
making it portable across different storage backends." Kuralle's `fsSkillStore` already takes a
`FileSystem`, so we are aligned here — this is the one place we match the peer by design.

## 4. DeepAgents: versioned protocol with a quarantined adapter

`backends/protocol.ts` re-exports `v1/protocol.ts` (`@deprecated`) and `v2/protocol.ts` (current),
with `adaptBackendProtocol` / `adaptSandboxProtocol` in `utils.ts` bridging v1 → v2. The v2 file
documents the exact deltas ("`read()` returns `ReadResult` instead of a plain string", …).

This is the *disciplined* version of compatibility: one named adapter, one file, both versions
explicitly typed, deprecation on the old one. Contrast kuralle's `as HarnessStreamPart` cast — an
undocumented, unnamed, untyped bridge between two shapes, which is how the RFC-0002 defect survived.

The lesson is not "add versioned protocols". It is: **if a boundary genuinely needs two shapes, name
both and quarantine the adapter.** Never bridge with a cast.

## 5. Mastra: `ChunkFrom` and the network dimension

`ChunkFrom` = `AGENT | USER | SYSTEM | WORKFLOW | NETWORK`. Note `WORKFLOW` and `NETWORK` — Mastra
distinguishes events originating from a workflow step and from multi-agent networks. Kuralle emits
flow-node events (`node-enter`, `flow-transition`) and handoff events into the same flat stream with
no origin marker, so a consumer cannot separate "the agent said this" from "the flow moved".

This reinforces §1: origin belongs on the envelope.

---

## 6. What we do better (worth not losing)

Recording these so the reshape doesn't regress them:

- **Durable effect journal.** LangGraph's own checkpointer had the C2 concurrent-write bug we fixed;
  its docs concede side effects before an interrupt "should be idempotent". Our intent-before-execute
  + CAS is ahead of all three.
- **Flows as typed node graphs** with deterministic transitions. LangGraph has graphs but no
  conversational node kinds (`reply`/`collect`/`decide`); Mastra and DeepAgents have no flow
  primitive at all.
- **`FileSystem` portable to workerd/DO SQLite.** DeepAgents' backends are the closest analogue and
  are Node/LangGraph-store oriented; ours runs inside a Durable Object.

---

## 7. Recommended actions

| # | Action | Where |
|---|---|---|
| 1 | Adopt envelope + named payload types; keep the exhaustive channel map | **revise RFC 0002 §3** |
| 2 | ~~Layered skill sources (last-one-wins)~~ — implemented | RFC 0001, `fsSkillStore` |
| 3 | Never bridge shapes with a cast; name both sides and quarantine the adapter | convention → CONTRIBUTING |
| 4 | `seq` + replay cursors on the stream | new RFC — real gap, own scope |
| 5 | Provenance (`from` / `namespace`) on the envelope | new RFC — needed by RFC 0001 subagents |
| 6 | ~~Decide whether capabilities/processors/hooks stay three mechanisms~~ — ADR-0015 | fixed phases + one agent `policies.ts` |
