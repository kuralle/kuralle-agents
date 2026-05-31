#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const roleMessage =
  'You are an assistant for ABC Widget Company. You must ALWAYS use the available functions to progress the conversation. This is a phone conversation and your responses will be converted to audio. Keep the conversation friendly, casual, and polite. Avoid outputting special characters and emojis.';

const checkStore = defineTool({
  name: 'check_store_location_and_hours_of_operation',
  description: 'Check store location and hours of operation',
  input: z.object({}),
  execute: async () => ({
    status: 'success',
    store_location: '123 Main St, Anytown, USA',
    hours_of_operation: '9am to 5pm, Monday through Friday',
  }),
});

const startOrder = defineTool({
  name: 'start_order',
  description: 'Start placing an order',
  input: z.object({}),
  execute: async () => ({ status: 'error', error: 'Order backend unavailable' }),
});

const endCustomerTool = defineTool({
  name: 'end_customer_conversation',
  description: 'End the conversation',
  input: z.object({}),
  execute: async () => ({ done: true }),
});

const endCustomerConversation = reply({
  id: 'end_customer_conversation',
  instructions: 'Thank the customer warmly and mention they can call back anytime if they need more help.',
  model,
  next: () => ({ end: 'customer_flow_completed' }),
});

const connectHumans = action({
  id: 'connect_humans',
  run: async (state) => {
    state.customer_muted = false;
    state.customer_audio_mode = 'connected_to_agent';
    console.log('[Action] customer and human agent connected');
    return { end: 'human_handoff_completed' };
  },
});

const endHumanAgentConversation = reply({
  id: 'end_human_agent_conversation',
  instructions: "Tell the agent that you're patching them through to the customer right now.",
  model,
  next: () => connectHumans,
});

const humanAgentInteraction = reply({
  id: 'human_agent_interaction',
  instructions: `You're now talking to an agent who has just joined the call. Assume that the customer you were helping up until this point can no longer hear you. Your job is to be as helpful as you can and bring the agent up to speed so that they can assist the customer. Start by greeting the agent politely and explaining what the customer was trying to do that you were unable to help with, and any relevant error details. Ask the agent if they have any questions or whether they're ready to connect to the customer.

Once the agent tells you they're ready to connect to the customer, call the connect_human_agent_and_customer function.`,
  model,
  context: 'reset_with_summary',
  tools: buildToolSet({
    connect_human_agent_and_customer: defineTool({
      name: 'connect_human_agent_and_customer',
      description: 'Connect the human agent to the customer',
      input: z.object({}),
      execute: async () => ({ connected: true }),
    }),
  }),
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'connect_human_agent_and_customer')
      ? endHumanAgentConversation
      : 'stay',
});

const transferringToHuman = reply({
  id: 'transferring_to_human_agent',
  instructions:
    'Start by apologizing to the customer that there was an issue fulfilling their last request, then inform them that they are being transferred to a human agent. Tell them to please hold while you connect them, and thank them for their patience.',
  model,
  tools: buildToolSet({
    start_human_agent_interaction: defineTool({
      name: 'start_human_agent_interaction',
      description: 'Call this when the human agent has joined the room and is ready for handoff context.',
      input: z.object({}),
      execute: async () => ({ ready: true }),
    }),
  }),
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'start_human_agent_interaction') ? humanAgentInteraction : 'stay',
});

const printAgentUrl = action({
  id: 'print_agent_url',
  run: async () => {
    console.log('[Action] JOIN AS AGENT: https://example.invalid/agent');
    return transferringToHuman;
  },
});

const hearHoldOnly = action({
  id: 'hear_hold_only',
  run: async (state) => {
    state.customer_audio_mode = 'hold_music_only';
    console.log('[Action] customer now hears hold music only');
    return printAgentUrl;
  },
});

const startHoldMusic = action({
  id: 'start_hold_music',
  run: async (state) => {
    state.hold_music = 'playing';
    console.log('[Action] hold music started');
    return hearHoldOnly;
  },
});

const muteCustomer = action({
  id: 'mute_customer',
  run: async (state) => {
    state.customer_muted = true;
    console.log('[Action] customer muted');
    return startHoldMusic;
  },
});

function customerNext(turn: import('../../src/types/channel.js').TurnResult, continued: ReturnType<typeof reply>) {
  if (turn.toolResults.some((r) => r.name === 'end_customer_conversation')) return endCustomerConversation;
  if (turn.toolResults.some((r) => r.name === 'check_store_location_and_hours_of_operation')) return continued;
  if (turn.toolResults.some((r) => r.name === 'start_order')) return muteCustomer;
  return 'stay';
}

const continuedCustomerInteraction = reply({
  id: 'continued_customer_interaction',
  instructions: `Ask the customer there's anything else you could help them with today, or if they'd like to end the conversation. If they need more help, re-offer the two choices you offered before: you could provide store location and hours of operation, or begin placing an order.

To help the customer:
- Use the check_store_location_and_hours_of_operation function to check store location and hours of operation to provide to the customer
- Use the start_order function to begin placing an order on the customer's behalf

If the customer wants to end the conversation, call the end_customer_conversation function.`,
  model,
  tools: buildToolSet({
    check_store_location_and_hours_of_operation: checkStore,
    start_order: startOrder,
    end_customer_conversation: endCustomerTool,
  }),
  next: (turn) => customerNext(turn, continuedCustomerInteraction),
});

const customerInteraction = reply({
  id: 'customer_interaction',
  instructions: `${roleMessage}\n\nStart off by greeting the customer. Then ask how you could help, offering two choices of what you could help with: you could provide store location and hours of operation, or begin placing an order. Be friendly and casual.

To help the customer:
- Use the check_store_location_and_hours_of_operation function to check store location and hours of operation to provide to the customer
- Use the start_order function to begin placing an order on the customer's behalf

If the customer wants to end the conversation, call the end_customer_conversation function.`,
  model,
  tools: buildToolSet({
    check_store_location_and_hours_of_operation: checkStore,
    start_order: startOrder,
    end_customer_conversation: endCustomerTool,
  }),
  next: (turn) => customerNext(turn, continuedCustomerInteraction),
});

const agent = defineAgent({
  id: 'warm-transfer-flow',
  name: 'Warm Transfer (Pipecat parity)',
  instructions: roleMessage,
  model,
  flows: [
    defineFlow({
      name: 'transfer',
      description: 'Warm transfer to human agent',
      start: customerInteraction,
      nodes: [
        customerInteraction,
        continuedCustomerInteraction,
        muteCustomer,
        startHoldMusic,
        hearHoldOnly,
        printAgentUrl,
        transferringToHuman,
        humanAgentInteraction,
        endHumanAgentConversation,
        connectHumans,
        endCustomerConversation,
      ],
    }),
  ],
});

runV2Conversation({
  title: 'Pipecat Warm Transfer (v2)',
  agent,
  prompts: [
    'Hi, can you tell me your store location and hours?',
    'Thanks, now I want to place an order.',
    'Okay, I can hold. The human agent has joined.',
    'Agent here. I am ready to connect to the customer.',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
