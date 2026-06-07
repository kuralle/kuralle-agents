/**
 * Shared test agents for SIP transport E2E tests.
 *
 * These agents are used across offline (FakeRealtimeAudioClient) and live
 * (Gemini/OpenAI/xAI) SIP tests. Extracted here so all SIP transport tests
 * exercise the same agent configuration.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { AgentConfig } from '@kuralle-agents/core/types';
import { wrapAiSdkTool } from '@kuralle-agents/core';
import type { CannedResponse } from './fake_realtime_client.js';

// ─── Tools ───────────────────────────────────────────────────────────────────

export const checkWeather = tool({
  description: 'Check the current weather for a city',
  inputSchema: z.object({
    city: z.string().describe('City name'),
  }),
  execute: async ({ city }) => {
    console.log(`  [tool] check_weather("${city}")`);
    return { city, temperature: 22, condition: 'partly cloudy', humidity: 65 };
  },
});

export const lookupOrder = tool({
  description: 'Look up an order by ID',
  inputSchema: z.object({
    orderId: z.string().describe('The order ID'),
  }),
  execute: async ({ orderId }) => {
    console.log(`  [tool] lookupOrder("${orderId}")`);
    if (orderId === 'ORD-123') {
      return { status: 'shipped', tracking: '1Z999', estimatedDelivery: '2026-04-17' };
    }
    return { status: 'not_found' };
  },
});

export const transferToHuman = tool({
  description: 'Transfer the caller to a human agent',
  inputSchema: z.object({
    reason: z.string().describe('Reason for transfer'),
  }),
  execute: async ({ reason }) => {
    console.log(`  [tool] transferToHuman("${reason}")`);
    return { transferred: true, queue: 'support', estimatedWait: '2 minutes' };
  },
});

// ─── Agent Configs ───────────────────────────────────────────────────────────

export const supportAgent: AgentConfig = {
  id: 'support',
  name: 'Customer Support',
  instructions: `You are a helpful customer support agent on a phone call.
When the user asks about orders, use the lookupOrder tool.
When the user asks about weather, use the check_weather tool.
If the user wants to speak to a human, use transferToHuman.
Keep responses concise — this is a phone call.`,
  tools: {
    check_weather: wrapAiSdkTool('check_weather', checkWeather),
    lookupOrder: wrapAiSdkTool('lookupOrder', lookupOrder),
    transferToHuman: wrapAiSdkTool('transferToHuman', transferToHuman),
  },
};

// ─── Canned Responses (for FakeRealtimeAudioClient) ──────────────────────────

export const cannedResponses: Record<string, CannedResponse> = {
  hello: { text: 'Hello! How can I help you today?' },
  order: {
    toolCalls: [{ name: 'lookupOrder', args: { orderId: 'ORD-123' } }],
    text: 'Your order ORD-123 has been shipped with tracking 1Z999.',
  },
  weather: {
    toolCalls: [{ name: 'check_weather', args: { city: 'Boston' } }],
    text: 'Boston is 22 degrees and partly cloudy.',
  },
  transfer: {
    toolCalls: [{ name: 'transferToHuman', args: { reason: 'customer request' } }],
    text: 'Transferring you now.',
  },
  bye: { text: 'Goodbye! Have a great day.' },
};

export const defaultCannedResponse: CannedResponse = {
  text: "I'm sorry, I didn't catch that. Could you repeat?",
};
