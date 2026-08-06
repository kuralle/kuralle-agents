import { describe, expect, it } from 'bun:test';
import { createRuntime, MemoryStore } from '@kuralle-agents/core';
import type { StreamPart } from '@kuralle-agents/core';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { createLeadAgent } from '../../agent/lead.js';
import { createSpecialistAgents, SPECIALIST_IDS, type SpecialistId } from '../../agent/specialists.js';
import { testDeps } from './helpers.js';

// `LanguageModelV3Usage` nests token counts (`{ inputTokens: { total, noCache, ... } }`), unlike
// the flat V2 shape — `tsc` catches the mismatch even though the untyped runtime does not.
const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * A stub model — `OPENAI_API_KEY` is unset in this environment (see repo-root `.env`), and this
 * test needs the LEAD's routing decision to be deterministic per specialist rather than
 * dependent on live NLU, so a stub is the right tool here regardless of key availability.
 *
 * This proves the WIRING: the lead's `routes` names each specialist's real agent id, and the
 * runtime resolves a `transfer_to_agent` call for that id to an actual handoff (test 5) that
 * never speaks prose first (test 6). It does not exercise whether the `when` descriptions
 * themselves pick the right specialist for real natural-language input — that would need a
 * live model.
 *
 * Call 1 (the lead's turn): call `transfer_to_agent` for the target. Call 2+ (the specialist's
 * turn): answer in plain text, so the turn ends without leaving the mock's queue empty.
 */
function scriptedTransferModel(targetAgentId: SpecialistId) {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'transfer-1',
                toolName: 'transfer_to_agent',
                input: JSON.stringify({ targetAgentId, reason: 'scripted routing test' }),
              },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: USAGE },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 's' },
            { type: 'text-delta', id: 's', delta: 'Working on it now.' },
            { type: 'text-end', id: 's' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
          ],
        }),
      };
    },
  }) as never;
}

const SCRIPTED_REQUESTS: Record<SpecialistId, string> = {
  'product-marketer': 'Our positioning is stale — help us rework who this product is for.',
  'content-marketer': 'Write a blog post about our new integration.',
  email: 'Turn this into a newsletter broadcast for our subscribers.',
  seo: 'Audit our pricing page — it stopped ranking last month.',
  'social-media-coordinator': 'Draft a launch post for X and LinkedIn.',
};

async function runRoutedTurn(target: SpecialistId, input: string) {
  const deps = testDeps();
  const model = scriptedTransferModel(target);
  const lead = { ...createLeadAgent(deps), model };
  const specialists = (await createSpecialistAgents(deps)).map((agent) => ({ ...agent, model }));
  const runtime = createRuntime({
    agents: [lead, ...specialists],
    defaultAgentId: 'lead',
    sessionStore: new MemoryStore(),
    defaultModel: model,
  });
  const parts: StreamPart[] = [];
  const handle = runtime.run({ sessionId: `route-${target}-${Math.random()}`, input });
  for await (const part of handle.events) parts.push(part);
  await handle;
  return parts;
}

describe('b5 test 5: routes/routing resolve to the right specialist', () => {
  for (const id of SPECIALIST_IDS) {
    it(`"${SCRIPTED_REQUESTS[id]}" routes to ${id}`, async () => {
      const parts = await runRoutedTurn(id, SCRIPTED_REQUESTS[id]);

      const handoff = parts.find((p) => p.type === 'handoff');
      expect(handoff, `no handoff part was emitted routing to ${id}`).toBeDefined();
      expect((handoff!.payload as { targetAgent?: string }).targetAgent).toBe(id);

      // test 6: dispatch is silent — no text-delta escapes before the routing decision lands.
      const handoffIndex = parts.indexOf(handoff!);
      const textBeforeHandoff = parts
        .slice(0, handoffIndex)
        .filter((p) => p.type === 'text-delta');
      expect(textBeforeHandoff, `the lead spoke before routing to ${id}, leaking the decision`).toHaveLength(0);
    });
  }
});

describe('b5 test 6: routing never appears in user-visible output', () => {
  it('the visible reply text never names the routing mechanism or a target agent id', async () => {
    const parts = await runRoutedTurn('seo', SCRIPTED_REQUESTS.seo);
    const visibleText = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => (p.payload as { delta: string }).delta)
      .join('')
      .toLowerCase();

    for (const id of SPECIALIST_IDS) {
      expect(visibleText.includes(id), `visible text named the agent id "${id}"`).toBe(false);
    }
    for (const banned of ['transfer', 'routing', 'dispatch', 'hand off', 'handoff']) {
      expect(visibleText.includes(banned), `visible text leaked "${banned}": ${visibleText}`).toBe(false);
    }
  });

  it('no internal handoff/tool-call/tool-result part is duplicated onto the client channel', async () => {
    const parts = await runRoutedTurn('email', SCRIPTED_REQUESTS.email);
    const clientParts = parts.filter((p) => p.channel === 'client');
    const leakedTypes = new Set(['handoff', 'tool-call', 'tool-result']);
    const leaked = clientParts.filter((p) => leakedTypes.has(p.type));
    expect(leaked, `routing-internal part types reached the client channel: ${JSON.stringify(leaked)}`).toHaveLength(0);
  });
});
