/**
 * Live AI SDK UIMessage path — req #5. an earlier decision default output is
 * `toUIMessageStreamResponse()` which maps the envelope through
 * `harnessToUIMessageStream`. Verify a real run yields a valid SSE body a
 * useChat client could render (text-start/delta/end + finish metadata).
 *
 * Run: bun run packages/core/examples/stream-contract/review-uimessage-live.ts
 */
import 'dotenv/config';
import { createOpenAI } from '@ai-sdk/openai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { newSessionId } from '../../src/runtime/openRun.js';

delete process.env.XAI_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}
const model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
console.log(`Live UIMessage provider: openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}`);

const agent = defineAgent({
  id: 'ui-smoke',
  name: 'UI Smoke',
  instructions: 'Reply with one short sentence.',
  model,
});
const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  sessionStore: new MemoryStore(),
  defaultModel: model,
});

const sid = newSessionId();
const handle = runtime.run({ sessionId: sid, input: 'Say hello in one short sentence.' });
const response = handle.toUIMessageStreamResponse({ sessionId: sid });
const body = await new Response(response.body).text();

let failures = 0;
const expect = (label: string, ok: boolean) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures += 1;
};

console.log('content-type:', response.headers.get('content-type'));
expect("SSE content-type is text/event-stream", (response.headers.get('content-type') ?? '').includes('text/event-stream'));
expect("body has 'start' metadata chunk", body.includes('"type":"start"'));
expect("body has text-start", body.includes('"type":"text-start"'));
expect("body has text-delta", body.includes('"type":"text-delta"'));
expect("body has text-end", body.includes('"type":"text-end"'));
expect("body has 'finish' metadata chunk", body.includes('"type":"finish"'));
expect("body carries sessionId metadata", body.includes('"sessionId"'));
// The envelope must NOT leak raw {channel,type,payload} into the UIMessage
// stream — it should be decoded into AI SDK chunk shapes.
expect("body does not leak raw envelope 'channel' field", !body.includes('"channel":"client"'));

console.log(`\n=== UIMessage live ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s)) ===`);
process.exit(failures === 0 ? 0 : 1);
