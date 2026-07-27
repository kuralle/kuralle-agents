/**
 * Input-cache rate measurement (Eve's formula).
 *
 *     rate = Σ cache_read / (Σ cache_read + Σ uncached_input)
 *     uncached_input = input_total − cache_read − cache_write
 *
 * Limits:
 *  - Without ANTHROPIC_API_KEY this measures the OpenAI path (automatic caching
 *    + promptCacheKey). Our Anthropic breakpoint code does not run there.
 *  - With ANTHROPIC_API_KEY set, a second block exercises the direct-Anthropic
 *    breakpoint path (the only path where applyPromptCache places markers).
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

const BIG_INSTRUCTIONS =
  'You are an archive assistant. Follow these rules precisely.\n' +
  Array.from({ length: 80 }, (_, i) => `Rule ${i + 1}: always cite the page number you read.`).join(
    '\n',
  );

type UsageTotals = { read: number; write: number; input: number; steps: number };

async function runSession(
  label: string,
  model: unknown,
  sessionId: string,
): Promise<{ rate: number; totals: UsageTotals }> {
  const agent = defineAgent({
    id: 'archivist',
    model: model as never,
    instructions: BIG_INSTRUCTIONS,
    globalTools: { fetch_archive_page },
  });
  const runtime = createRuntime({ agents: [agent], defaultAgentId: 'archivist' });
  const totals: UsageTotals = { read: 0, write: 0, input: 0, steps: 0 };

  async function turn(text: string) {
    const handle = runtime.run({ sessionId, input: text });
    for await (const part of handle.events as AsyncIterable<StreamPart>) {
      if (part.type === 'done' && part.payload?.usage) {
        const u = part.payload.usage;
        totals.steps += 1;
        totals.input += u.inputTokens ?? 0;
        totals.read += u.cacheReadTokens ?? 0;
        totals.write += u.cacheWriteTokens ?? 0;
        console.log(
          `  turn ${totals.steps}: input=${u.inputTokens ?? 0} cacheRead=${u.cacheReadTokens ?? 0} cacheWrite=${u.cacheWriteTokens ?? 0}`,
        );
      }
    }
    await handle;
  }

  console.log(`── ${label} ──`);
  await turn('Fetch archive pages 1, 2 and 3, one tool call at a time, then say PAGES LOADED.');
  await turn('Now fetch archive page 4 the same way, then say DONE.');

  const uncached = Math.max(0, totals.input - totals.read - totals.write);
  const rate = totals.read + uncached === 0 ? 0 : totals.read / (totals.read + uncached);

  console.log(`\n── ${label} rate ──`);
  console.log(`  total input tokens : ${totals.input}`);
  console.log(`  served from cache  : ${totals.read}`);
  console.log(`  cache writes       : ${totals.write}`);
  console.log(`  uncached           : ${uncached}`);
  console.log(`  INPUT-CACHE RATE   : ${(rate * 100).toFixed(2)}%   (Eve's bar: > 99%)`);
  console.log(
    rate === 0
      ? '\n  ZERO — nothing is being served from cache on this path.'
      : `\n  ${(rate * 100).toFixed(1)}% cached.`,
  );
  return { rate, totals };
}

const openaiResult = await runSession(
  'OpenAI gpt-4.1-mini (promptCacheKey path)',
  openai('gpt-4.1-mini'),
  'cache-baseline-openai',
);

// Direct-Anthropic measurement requires both ANTHROPIC_API_KEY and
// `@ai-sdk/anthropic` (not a core dependency). Breakpoint placement is
// covered by unit tests (detectPromptCachePath / applyPromptCache).
if (process.env.ANTHROPIC_API_KEY) {
  console.log(
    '\n── Anthropic direct: set up `@ai-sdk/anthropic` locally to measure the breakpoint path ──',
  );
} else {
  console.log(
    '\n── Anthropic direct skipped (no ANTHROPIC_API_KEY) — breakpoint path covered by unit tests ──',
  );
}

console.log(`\n── summary ──`);
console.log(`  openai INPUT-CACHE RATE: ${(openaiResult.rate * 100).toFixed(2)}%`);
