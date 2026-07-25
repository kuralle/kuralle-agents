/**
 * REQ-7 / audience-split proof over real HTTP/SSE.
 *
 * Serves one runtime through @kuralle-agents/hono-server under two filters
 * ('safe' and 'all') on separate paths, POSTs the same message to each, parses
 * the SSE frames, and asserts:
 *   - 'safe' emits ZERO channel:'internal' parts
 *   - 'all'   emits some channel:'internal' parts (flows produce node-enter etc.)
 *
 * This is the whole point of the reshape: prove the audience split holds on the
 * wire with curl-equivalent evidence, not by reading the filter.
 *
 * Run: bun run packages/core/examples/stream-contract/review-hono-channels.ts
 */
import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import {
  createRuntime,
  defineAgent,
  defineFlow,
  collect,
  reply,
  type StreamPart,
  MemoryStore,
} from '@kuralle-agents/core';
import { createKuralleSseChatRouter } from '@kuralle-agents/hono-server';

delete process.env.XAI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}
const model = createOpenAI({ apiKey: openaiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');

// A flow agent so the stream carries internal-channel parts (node-enter, etc).
const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the name in one short sentence.',
  model,
  next: () => ({ end: 'name-complete' }),
});
const nameCollect = collect({
  id: 'name',
  schema: z.object({ name: z.string().min(1) }),
  required: ['name'],
  maxTurns: 5,
  instructions: () => 'Ask for the name in one short question.',
  onComplete: () => confirm,
});
const flow = defineFlow({
  name: 'name-intake',
  description: 'Collect a name then confirm',
  start: nameCollect,
  nodes: [nameCollect, confirm],
});
const agent = defineAgent({
  id: 'flow-agent',
  name: 'Flow',
  instructions: 'Collect a name then confirm.',
  model,
  flows: [flow],
});

function makeRuntime() {
  return createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
}

const app = new Hono();
// Two identical runtimes, two filters — same agent shape, deterministic split.
app.route('/safe', createKuralleSseChatRouter({ runtime: makeRuntime(), streamFilter: 'safe' }));
app.route('/all', createKuralleSseChatRouter({ runtime: makeRuntime(), streamFilter: 'all' }));

const port = 4321 + Math.floor(Math.random() * 1000);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`review-hono-channels listening on ${info.port}`);
});

interface ParsedFrame {
  channel: string;
  type: string;
}

async function postSSE(path: string, message: string): Promise<ParsedFrame[]> {
  const res = await fetch(`http://localhost:${port}${path}/api/chat/sse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  const frames: ParsedFrame[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data: ')) continue;
    try {
      const part = JSON.parse(trimmed.slice('data: '.length)) as Partial<StreamPart>;
      if (typeof part.channel === 'string' && typeof part.type === 'string') {
        frames.push({ channel: part.channel, type: part.type });
      }
    } catch {
      // ignore non-JSON keepalive lines
    }
  }
  return frames;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}: ${detail}`);
  }
}

try {
  const message = "Hi, I'd like to introduce myself.";
  console.log('POSTing to /safe ...');
  const safeFrames = await postSSE('/safe', message);
  console.log(`  received ${safeFrames.length} frames; types=[${[...new Set(safeFrames.map((f) => f.type))].join(',')}]`);
  console.log('POSTing to /all ...');
  const allFrames = await postSSE('/all', message);
  console.log(`  received ${allFrames.length} frames; types=[${[...new Set(allFrames.map((f) => f.type))].join(',')}]`);

  const safeInternal = safeFrames.filter((f) => f.channel === 'internal');
  const allInternal = allFrames.filter((f) => f.channel === 'internal');
  const safeClient = safeFrames.filter((f) => f.channel === 'client');

  check(
    "safe filter emits ZERO internal-channel parts",
    safeInternal.length === 0,
    `leaked ${safeInternal.length}: ${safeInternal.map((f) => f.type).join(',')}`,
  );
  check(
    "all filter emits some internal-channel parts (flow/node events)",
    allInternal.length > 0,
    `got ${allInternal.length} internal frames`,
  );
  check(
    "safe filter still emits client-channel parts (text/done)",
    safeClient.length > 0,
    `got ${safeClient.length} client frames`,
  );
  check(
    "every safe frame's channel is 'client'",
    safeFrames.every((f) => f.channel === 'client'),
    `non-client channels: ${[...new Set(safeFrames.map((f) => f.channel))].join(',')}`,
  );
  // Channel/type consistency on the wire: every frame's channel must match the
  // authoritative classification for its type (proves the split is keyed on
  // PART_CHANNEL, not on a parallel hand-maintained set).
  const { PART_CHANNEL } = await import('@kuralle-agents/core');
  const consistent = allFrames.every((f) => PART_CHANNEL[f.type as StreamPart['type']] === f.channel);
  check(
    "every emitted channel agrees with PART_CHANNEL[type]",
    consistent,
    'channel drift on the wire',
  );
} finally {
  server.close();
}

console.log(`\n=== hono channels review ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
