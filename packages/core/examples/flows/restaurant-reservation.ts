#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

class MockReservationSystem {
  private readonly bookedTimes = new Set(['7:00 PM', '8:00 PM']);

  async checkAvailability(partySize: number, requestedTime: string) {
    await new Promise((r) => setTimeout(r, 500));
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
  'You are a restaurant reservation assistant for La Maison, an upscale French restaurant. Be casual and friendly. This is a voice conversation, so avoid special characters and emojis.';
const initialTask =
  "Warmly greet the customer and ask how many people are in their party. This is your only job for now; if the customer asks for something else, politely remind them you can't do it.";

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
  description: 'Check availability for requested time',
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

const end = reply({
  id: 'end',
  instructions: 'Thank them and end the conversation.',
  model,
  next: () => ({ end: 'reservation_completed' }),
});

const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the reservation details and ask if they need anything else.',
  model,
  tools: buildToolSet({ end_conversation: endConversation }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'end_conversation') ? end : 'stay'),
});

type TurnResult = import('../../src/types/channel.js').TurnResult;
type ReplyNode = ReturnType<typeof reply>;

const availabilityNext = (turn: TurnResult, noAvail: ReplyNode) => {
  const r = turn.toolResults.find((t) => t.name === 'check_availability');
  if (!r?.result || typeof r.result !== 'object') return 'stay';
  const data = r.result as Record<string, unknown>;
  return { goto: data.available ? confirm : noAvail, data };
};

const noAvailability = reply({
  id: 'no_availability',
  instructions: ({ state }) =>
    `Apologize that the requested time is not available. Suggest these alternative times: ${JSON.stringify(state.alternative_times ?? [])}. Ask if they'd like to try one of these times.`,
  model,
  tools: buildToolSet({ check_availability: checkAvailability, end_conversation: endConversation }),
  next(turn) {
    if (turn.toolResults.some((r) => r.name === 'end_conversation')) return end;
    return availabilityNext(turn, noAvailability);
  },
});

const getTime = reply({
  id: 'get_time',
  instructions: "Ask what time they'd like to dine. Restaurant is open 5 PM to 10 PM.",
  model,
  tools: buildToolSet({ check_availability: checkAvailability }),
  next: (turn) => availabilityNext(turn, noAvailability),
});

const initial = reply({
  id: 'initial',
  instructions: `${roleMessage}\n\n${initialTask}`,
  model,
  tools: buildToolSet({ collect_party_size: collectPartySize }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'collect_party_size');
    if (r?.result) return { goto: getTime, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const agent = defineAgent({
  id: 'restaurant-reservation',
  name: 'Restaurant Reservation (Pipecat parity)',
  instructions: roleMessage,
  model,
  flows: [
    defineFlow({
      name: 'reservation',
      description: 'Book a table at La Maison',
      start: initial,
      nodes: [initial, getTime, confirm, noAvailability, end],
    }),
  ],
});

runV2Conversation({
  title: 'Pipecat Restaurant Reservation (v2)',
  agent,
  prompts: ['Hi, I need a reservation', 'Party of 4', '7:00 PM', 'How about 6:00 PM then?', 'That works, thanks'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
