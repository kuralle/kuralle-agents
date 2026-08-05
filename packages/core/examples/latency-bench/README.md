# latency-bench

Deterministic, offline benchmark for runtime latency and tool scheduling.
No API key, no network — every scenario drives `MockLanguageModelV3` with fixed
inter-chunk delays so a before/after delta is attributable to a framework change
rather than to provider jitter.

```bash
bun packages/core/examples/latency-bench/bench.ts --label before
# ...land changes...
bun packages/core/examples/latency-bench/bench.ts --label after
bun packages/core/examples/latency-bench/bench.ts --compare before after
```

Writes `runs/<label>.jsonl` (every `StreamPart` with its arrival offset — gitignored,
it is bulky machine state), plus committed evidence in
`baselines/<label>.summary.json` and `baselines/compare-<a>-<b>.md`.

## Metrics

| metric | meaning |
| --- | --- |
| `ttft_ms` | first `text-delta` on the client channel |
| `ttfs_ms` | first **speakable sentence** — the TTFA proxy |
| `turn_ms` | until `await handle` resolves, including run-close work |
| `done_part_ms` | when the `done` part arrives |
| `close_tail_ms` | `turn_ms − done_part_ms` — what the user waits for after the stream looks finished |
| `peak_tool_concurrency` | highest simultaneous tool executions observed |
| `tool_result_order` | order tool results reached the transcript |
| `client_errors` | `error` parts the user would actually see |
| `abnormal_finish_observed` | did a non-`stop` finish reason surface at all |

### On TTFA

**This repository has no audio path.** Voice was extracted to a separate repo;
`ls packages/` confirms no `realtime-audio` / `voice-protocol` package remains,
and nothing in `packages/*/src` references audio deltas. A literal
time-to-first-audio is therefore **not measurable here and is not reported** —
publishing one would be a fabricated number.

`ttfs_ms` is the honest proxy. A cascaded TTS pipeline cannot synthesise until it
has a complete utterance, so time-to-first-sentence is the exact quantity that
gates first audio: whatever the runtime shaves off `ttfs_ms`, it shaves off TTFA
downstream. For a realtime speech-to-speech model the proxy does not hold and
TTFA must be measured in the voice repo against a real audio stream.

## Scenarios

| scenario | what it probes |
| --- | --- |
| `text-only` | TTFT / TTFS floor with nothing in the way |
| `tools-parallel-12` | concurrency ceiling, result ordering, CAS contention |
| `tool-huge-result` | transcript growth from an unbounded tool result |
| `memory-ingest` | what the user waits for after the answer is written |
| `finish-length` | whether an output-limit truncation is visible at all |

## What the baseline exposed

Captured on a clean tree at `5ed3de3` before any changes landed:

- **`tools-parallel-12` emits 4 client-facing `error` parts.** Above 8-way
  in-process tool concurrency the session store's optimistic-concurrency check
  rejects concurrent writes — `Stale write for session …: expected version 15,
  stored version is 16`. The tool results still land (12/12); what the user sees
  is spurious error noise. A probe across concurrency levels pinned it exactly:

  | calls | limit | results | errors |
  | ---: | ---: | ---: | ---: |
  | 12 | unbounded | 12/12 | **4** |
  | 12 | 8 | 12/12 | 0 |
  | 12 | 4 | 12/12 | 0 |
  | 8 | unbounded | 8/8 | 0 |

  Bounding tool concurrency at 8 removes the error path entirely. That is
  empirical support for the default, independent of it matching neo's constant.

- **`memory-ingest` turns take 3× as long.** 227.7ms against a 75ms floor,
  because post-turn ingest is awaited inside `closeRun` — and the `done` part
  waits with it, so the stream itself stays open for the extra 150ms.

- **`finish-length` reports a clean turn.** An output-limit truncation produces
  no signal anywhere: `abnormal_finish_observed: false`, and `ttfs_ms` is `null`
  because the text was cut mid-sentence and no speakable unit ever formed.

## Reading the JSONL

Each line is one `StreamPart` plus `scenario` and `at_ms`:

```bash
jq -r 'select(.scenario=="tools-parallel-12" and .type=="tool-result")
       | "\(.at_ms) \(.payload.toolCallId)"' runs/before.jsonl
```

That query is also the ordering check: with source-order emission the
`toolCallId` column reads `call-0 … call-11` on every run regardless of
completion timing.
