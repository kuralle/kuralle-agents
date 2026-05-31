/**
 * Post-call audit: @kuralle-agents/eval TranscriptReplay + core scoreTurn.
 * Run: bun run packages/kuralle-e2e-tests/tests/postcall-audit/05-eval-replay-and-score.ts
 */
import { fileURLToPath } from 'node:url';

import { TranscriptReplay, runGoldenSuite } from '@kuralle-agents/eval';
import { scoreTurn } from '@kuralle-agents/core';

const fixture = fileURLToPath(
  new URL('../../../kuralle-eval/fixtures/golden/quickstart_favorite_color_path.jsonl', import.meta.url),
);
const manifest = fileURLToPath(new URL('../../../kuralle-eval/fixtures/golden.manifest.json', import.meta.url));

const replay = await TranscriptReplay.fromFile(fixture);
replay
  .expectEventOrder(['input', 'tool-call', 'tool-result', 'done'])
  .expectToolCalled('record_favorite_color_func')
  .expectNoToolMismatches()
  .expectNoErrors()
  .expectDone();

const golden = await runGoldenSuite(manifest);

const checks = scoreTurn(
  {
    toolCalls: ['record_favorite_color_func'],
    responseContains: ['favorite'],
  },
  'Thanks for telling me your favorite color.',
  ['record_favorite_color_func'],
  [],
  12,
);

console.log(
  JSON.stringify(
    {
      script: '05-eval-replay-and-score.ts',
      replayStats: replay.stats(),
      goldenSuite: golden,
      scoreTurnSample: checks,
    },
    null,
    2,
  ),
);
