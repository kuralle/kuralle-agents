import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { tool as aiTool, type ToolSet } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import {
  createRuntime,
  defineAgent,
  defineFlow,
  defineTool,
  MemoryStore,
  reply,
  type Runtime,
} from '@kuralle-agents/core';
import { createKuralleRouter } from '../../src/index.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
loadEnv({ path: envPath });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const model = openai('gpt-4o-mini');

class MockReservationSystem {
  private readonly bookedTimes = new Set(['7:00 PM', '8:00 PM']);

  async checkAvailability(partySize: number, requestedTime: string) {
    await new Promise((r) => setTimeout(r, 100));
    const available = !this.bookedTimes.has(requestedTime);
    const alternatives = available
      ? []
      : ['5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'].filter(
          (t) => !this.bookedTimes.has(t),
        );
    return { available, alternatives };
  }
}

const reservationSystem = new MockReservationSystem();

const roleMessage =
  'You are a restaurant reservation assistant for La Maison, an upscale French restaurant. Be casual and friendly.';

function toToolSet(tools: Record<string, ReturnType<typeof defineTool>>): ToolSet {
  const set: ToolSet = {};
  for (const [key, def] of Object.entries(tools)) {
    const name = def.name ?? key;
    const spec: { description: string; inputSchema?: typeof def.input } = {
      description: def.description,
    };
    if (def.input) spec.inputSchema = def.input;
    set[name] = aiTool(spec as Parameters<typeof aiTool>[0]);
  }
  return set;
}

const timeSchema = z
  .string()
  .regex(/^([5-9]|10):00 PM$/)
  .describe("Reservation time (e.g., '6:00 PM')");

const endConversation = defineTool({
  name: 'end_conversation',
  description: 'End the conversation',
  input: z.object({}),
  execute: async () => ({ done: true }),
});

const checkAvailability = defineTool({
  name: 'check_availability',
  description: 'Check availability for the requested reservation time',
  input: z.object({ time: timeSchema, party_size: z.number().int() }),
  execute: async ({ time, party_size }) => {
    const { available, alternatives } = await reservationSystem.checkAvailability(party_size, time);
    return {
      time,
      party_size,
      available,
      alternative_times: available ? [] : alternatives,
    };
  },
});

const collectPartySize = defineTool({
  name: 'collect_party_size',
  description: 'Record the number of people in the party',
  input: z.object({ size: z.number().int().min(1).max(12) }),
  execute: async ({ size }) => ({ party_size: size }),
});

type TurnResult = import('@kuralle-agents/core').TurnResult;
type ReplyNode = ReturnType<typeof reply>;

const availabilityNext = (turn: TurnResult, noAvail: ReplyNode) => {
  const r = turn.toolResults.find((t) => t.name === 'check_availability');
  if (!r?.result || typeof r.result !== 'object') return 'stay';
  const data = r.result as Record<string, unknown>;
  return { goto: data.available ? confirm : noAvail, data };
};

const end = reply({
  id: 'end',
  instructions: 'Thank them and end the conversation.',
  model,
  next: () => ({ end: 'reservation_confirmed' }),
});

const confirm = reply({
  id: 'confirm',
  instructions:
    'Confirm the reservation details and ask if they need anything else.',
  model,
  tools: toToolSet({ end_conversation: endConversation }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'end_conversation') ? end : 'stay'),
});

const noAvailability = reply({
  id: 'no_availability',
  instructions: ({ state }) =>
    `Apologize that the requested time is not available. Suggest these alternative times: ${JSON.stringify(state.alternative_times ?? [])}. Ask if they'd like to try one of these times.`,
  model,
  tools: toToolSet({ check_availability: checkAvailability, end_conversation: endConversation }),
  next(turn) {
    if (turn.toolResults.some((r) => r.name === 'end_conversation')) return end;
    return availabilityNext(turn, noAvailability);
  },
});

const getTime = reply({
  id: 'get_time',
  instructions: "Ask what time they'd like to dine. Restaurant is open 5 PM to 10 PM.",
  model,
  tools: toToolSet({ check_availability: checkAvailability }),
  next: (turn) => availabilityNext(turn, noAvailability),
});

const initial = reply({
  id: 'initial',
  instructions: `${roleMessage}\n\nWarmly greet the customer and ask how many people are in their party.`,
  model,
  tools: toToolSet({ collect_party_size: collectPartySize }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'collect_party_size');
    if (r?.result) return { goto: getTime, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const agent = defineAgent({
  id: 'reservation-flow',
  name: 'Restaurant Reservation',
  instructions: roleMessage,
  model,
  effectTools: {
    collect_party_size: collectPartySize,
    check_availability: checkAvailability,
    end_conversation: endConversation,
  },
  flows: [
    defineFlow({
      name: 'reservation',
      description: 'Book a table at La Maison',
      start: initial,
      nodes: [initial, getTime, confirm, noAvailability, end],
    }),
  ],
});

const sessionId = 'reservation-flow';

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  sessionStore: new MemoryStore(),
  defaultModel: model,
});

function createFlowRouterManager(rt: Runtime) {
  let currentNodeName = '';
  const nodeHistory: string[] = [];
  let hasEnded = false;
  let collectedData: Record<string, unknown> = {};

  return {
    get currentNodeName() {
      return currentNodeName;
    },
    get nodeHistory() {
      return [...nodeHistory];
    },
    get hasEnded() {
      return hasEnded;
    },
    get collectedData() {
      return { ...collectedData };
    },
    async *process(input: string) {
      const handle = rt.run({ sessionId, input });
      for await (const part of handle.events) {
        if (part.type === 'node-enter') {
          currentNodeName = part.nodeName;
          nodeHistory.push(part.nodeName);
        }
        if (part.type === 'flow-end') {
          hasEnded = true;
        }
        if (part.type === 'text-delta') {
          yield { type: part.type, id: part.id, delta: part.delta };
        }
        if (part.type === 'error') {
          yield { type: part.type, error: part.error };
        }
      }
      await handle;
      const session = await rt.getSession(sessionId);
      const agentState = session?.agentStates[agent.id]?.state;
      if (agentState && typeof agentState === 'object') {
        collectedData = { ...agentState };
      }
    },
  };
}

const flowManager = createFlowRouterManager(runtime);

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.route('/', createKuralleRouter({ flowManager, sessionId, upgradeWebSocket }));

const port = Number(process.env.PORT ?? 3334);
const server = serve({ fetch: app.fetch, port });

injectWebSocket(server);

console.log(`Kuralle Flow Server running at http://localhost:${port}`);
console.log(`Endpoints:`);
console.log(`  GET  /health          - Health check`);
console.log(`  GET  /info            - Flow info`);
console.log(`  GET  /flow-state      - Current flow state`);
console.log(`  POST /api/flow/chat   - Chat with flow (JSON)`);
console.log(`  POST /api/flow/stream - Stream flow response`);
console.log(`  POST /api/flow/sse    - SSE stream all parts`);
console.log(`  WS   /ws              - WebSocket for real-time streaming`);
