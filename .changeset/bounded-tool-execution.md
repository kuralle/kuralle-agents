---
"@kuralle-agents/core": minor
---

Bound and order tool execution, and stop treating an abnormal finish as a completed turn.

**Breaking: `parallelSafe` is now `boolean | ((args) => boolean)`.** A static boolean forced a tool
with a read mode and a write mode to pick one classification for both. The predicate is evaluated on
the raw model arguments before schema validation, so it must be total — any throw or non-boolean
return fails closed to serial, and the model cannot influence the decision either way.

**Breaking: `replay: false` no longer implies parallel-safe.** They are unrelated properties: one
means "do not journal this step", the other means "safe to run concurrently with siblings". Tools
relying on the old implication must now declare `parallelSafe` explicitly.

**Tool concurrency is bounded by default.** `Limits.maxToolConcurrency` was optional and documented
as unbounded, and nothing ever set it, so the model's batch size was the concurrency policy. It now
defaults to 8 — a measured limit, not a copied one. Above roughly eight-way in-process concurrency
the run store's optimistic-concurrency check starts rejecting writes: against the durable store, 20
unbounded parallel calls executed only 8, and the other 12 threw `Stale write for session …` out of
`appendPendingStep` without ever reaching their executor.

**Tool results are capped where they enter the transcript.** Any user-defined tool could land an
unbounded payload in `run.messages` and re-send it on every subsequent model call. The cap lives in
`toolResultMessage` and nowhere else, so `ctx.tool()` and the durable journal keep the full value —
only what the model reads is bounded. Truncation is middle-out, because the end of a payload holds
the error, the total and the last record, and both seams back off UTF-8 continuation bytes.

**Parallel results are emitted and appended in source order.** Results used to append in completion
order, which varies with timing, and the internal `tool-call` parts interleaved for the same reason.
A batch now announces itself with one `tool-batch-start` carrying the ordered call refs before any
dispatch, so a UI can allocate a stable block before work starts and a replayed run rebuilds the
same layout.

**An abnormal finish is distinguishable from a clean stop.** `length`, `content-filter`, `error` and
`other` all took the same branch as `stop`, so a response truncated at the output-token limit ended
the turn as a success — the user got half a sentence and no caller could tell. The turn now carries
an explicit exit reason, and a new `turn-incomplete` internal stream part reports it. Only a
step-budget exit triggers the wrap-up call; retrying after an output-limit truncation just
reproduces it.
