/**
 * Baseline: what fraction of our prompt tokens are actually served from cache?
 *
 * Eve's metric (packages/eve/src/harness/prompt-cache.ts + the input-cache-rate eval):
 *
 *     rate = Σ cache_read / (Σ cache_read + Σ uncached_input)
 *     uncached_input = input_total − cache_read − cache_write
 *
 * They assert > 99% on a multi-step tool session and note that a lagging final
 * breakpoint collapses it to 45–60%.
 *
 * Two honest limits on what this can tell us:
 *
 *  - `cacheWriteTokens` is not plumbed anywhere in kuralle, so the denominator here
 *    treats writes as uncached. That biases the rate DOWN on the first turn and is
 *    correct from then on.
 *  - No ANTHROPIC_API_KEY in this environment, so this measures the OpenAI path.
 *    Our breakpoint code (`applyAnthropicCacheControl`) does not run for OpenAI at
 *    all — OpenAI caches automatically above ~1024 tokens. So this is a baseline for
 *    the path we actually run in practice, NOT a test of our breakpoint logic.
 *
 * Run: bun packages/core/examples/cache-baseline.ts
 */
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import { createRuntime, defineAgent, defineTool } from '../src/index.js';
import type { StreamPart } from '../src/types/stream.js';

const PAGES: Record<string, string> = {
  '1': 'Archive page 1: ' + 'lorem ipsum dolor sit amet consectetur. '.repeat(60),
  '2': 'Archive page 2: ' + 'sed do eiusmod tempor incididunt ut labore. '.repeat(60),
  '3': 'Archive page 3: ' + 'ut enim ad minim veniam quis nostrud. '.repeat(60),
  '4': 'Archive page 4: ' + 'duis aute irure dolor in reprehenderit. '.repeat(60),
};

const fetch_archive_page = defineTool({
  name: 'fetch_archive_page',
  description: 'Fetch one archive page by number.',
  replay: false,
  input: z.object({ page: z.string() }),
  execute: async ({ page }) => ({ page, content: PAGES[page] ?? 'not found' }),
});

// A deliberately large stable instruction block — this is the part that SHOULD be
// cached across every turn, and the part we currently cannot mark a breakpoint on.
const BIG_INSTRUCTIONS =
  'You are an archive assistant. Follow these rules precisely.\n' +
  Array.from({ length: 80 }, (_, i) => `Rule ${i + 1}: always cite the page number you read.`).join('\n');

const agent = defineAgent({
  id: 'archivist',
  model: openai('gpt-4.1-mini'),
  instructions: BIG_INSTRUCTIONS,
  globalTools: { fetch_archive_page },
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'archivist' });

let read = 0;
let input = 0;
let steps = 0;

async function turn(sessionId: string, text: string) {
  const handle = runtime.run({ sessionId, input: text });
  for await (const part of handle.events as AsyncIterable<StreamPart>) {
    if (part.type === 'done' && part.payload?.usage) {
      const u = part.payload.usage as {
        inputTokens?: number;
        cacheReadTokens?: number;
      };
      steps += 1;
      input += u.inputTokens ?? 0;
      read += u.cacheReadTokens ?? 0;
      console.log(
        `  turn ${steps}: input=${u.inputTokens ?? 0} cacheRead=${u.cacheReadTokens ?? 0}`,
      );
    }
  }
  await handle;
}

console.log('── multi-step tool session (Eve requires >= 4 model steps for the metric to mean anything) ──');
await turn('cache-baseline', 'Fetch archive pages 1, 2 and 3, one tool call at a time, then say PAGES LOADED.');
await turn('cache-baseline', 'Now fetch archive page 4 the same way, then say DONE.');

const uncached = Math.max(0, input - read);
const rate = read + uncached === 0 ? 0 : read / (read + uncached);

console.log('\n── baseline ──');
console.log(`  total input tokens : ${input}`);
console.log(`  served from cache  : ${read}`);
console.log(`  uncached           : ${uncached}`);
console.log(`  INPUT-CACHE RATE   : ${(rate * 100).toFixed(2)}%   (Eve's bar: > 99%)`);
console.log(
  rate === 0
    ? '\n  ZERO — nothing is being served from cache on this path.'
    : `\n  ${(rate * 100).toFixed(1)}% cached.`,
);
