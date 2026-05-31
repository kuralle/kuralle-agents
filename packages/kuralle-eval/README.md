# @kuralle-agents/eval

Deterministic replay and assertions for Kuralle transcript events — kept separate from `@kuralle-agents/core` to avoid test-only bloat in production bundles.

## Install

```bash
npm install @kuralle-agents/eval
```

No peers required.

## What it does

Load stored `.jsonl` transcripts, replay the event stream, and assert structural contracts — event order, tool-call integrity, flow end behavior — without depending on exact LLM wording.

**Key exports:**

- **`TranscriptReplay`** — fluent assertion API over a loaded transcript.
- **`ReplayAssertionError`** — thrown when a `TranscriptReplay` assertion fails.
- **`readTranscriptFile` / `readTranscriptDirectory` / `listTranscriptFiles`** — I/O helpers.
- **`loadGoldenManifest` / `runGoldenSuite`** — golden-fixture suite runner.
- **`registerScorer` / `getScorer` / `listScorers`** — pluggable scoring registry.

## Usage

```ts
import { TranscriptReplay } from '@kuralle-agents/eval';

const replay = await TranscriptReplay.fromFile('./transcripts/order-flow.jsonl');

replay
  .expectEventOrder(['input', 'tool-call', 'tool-result', 'done'])
  .expectToolCalled('start_order')
  .expectNoToolMismatches()
  .expectNoErrors()
  .expectDone();
```

## Golden fixtures

Commit golden transcripts as `.jsonl` files and run the suite in CI:

```ts
import { loadGoldenManifest, runGoldenSuite } from '@kuralle-agents/eval';

const manifest = await loadGoldenManifest('./fixtures/golden.manifest.json');
const results = await runGoldenSuite(manifest);
```

Typical workflow:

1. Run production-like examples; store transcript files.
2. Commit selected golden transcripts under `fixtures/`.
3. In CI, load with `TranscriptReplay` and assert structural contracts.

Tests stay stable even when model wording changes.

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — runtime that produces the transcript events this package replays.
