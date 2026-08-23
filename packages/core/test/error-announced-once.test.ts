import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { defineAgent } from '../src/authoring/defineAgent.js';
import { MemorySessionEventLog } from '../src/events/SessionEventLog.js';
import { createRuntime } from '../src/runtime/Runtime.js';
import { MemoryStore } from '../src/session/stores/MemoryStore.js';

/**
 * One failure must reach the log once.
 *
 * A failure is announced by every layer that catches it on the way up: AiSdkModelTurnLoop sees the
 * model stream's error part and emits before rethrowing, and speakGated's catch emits again as the
 * throw unwinds past it. Both are legitimate — each is the only announcement for failures that
 * originate in its own path — so the emit funnel they share drops the repeat, the same way it
 * already dropped a duplicate handoff.
 *
 * Found from a first-run TUI session with no API key, which showed the provider's message twice.
 * The event log held two identical `error` parts for it.
 */
async function failingTurnErrors(): Promise<string[]> {
  const eventLog = new MemorySessionEventLog();
  const runtime = createRuntime({
    eventLog,
    sessionStore: new MemoryStore(),
    defaultAgentId: 'a',
    agents: [defineAgent({
      id: 'a',
      instructions: 'x',
      model: new MockLanguageModelV3({
        doStream: async () => { throw new Error('BOOM'); },
        doGenerate: async () => { throw new Error('BOOM'); },
      }),
    })],
  });

  const handle = runtime.run({ sessionId: 's', input: 'hey' });
  for await (const _part of handle.events) { /* drain */ }
  await handle.catch(() => undefined);
  await runtime.settled();

  const { events } = await eventLog.read('s', 0);
  return events
    .filter((event) => event.part.type === 'error')
    .map((event) => (event.part as { payload: { error: string } }).payload.error);
}

describe('a failure is announced once', () => {
  it('writes one error part when two layers both catch and rethrow', async () => {
    expect(await failingTurnErrors()).toEqual(['BOOM']);
  });
});
