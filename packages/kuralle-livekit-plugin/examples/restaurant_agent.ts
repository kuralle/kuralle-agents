/**
 * Restaurant Agent with Kuralle
 *
 * A multi-agent restaurant system with specialized agents for greeting,
 * reservation, takeaway, and checkout — each with their own tools and
 * handoff logic.
 *
 * This is the Kuralle equivalent of LiveKit's restaurant_agent.ts.
 * Kuralle's Runtime handles agent routing, session state, and handoffs
 * natively — no need for manual chat context stitching or BaseAgent classes.
 *
 * Usage:
 *   npx tsx examples/restaurant_agent.ts
 *
 * Connect a WebSocket client to ws://localhost:8080
 * Send binary PCM audio (24kHz, mono, signed 16-bit LE)
 */

import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger, voice } from '@livekit/agents';
import { tool } from 'ai';
import { z } from 'zod';

const PORT = 8080;
initializeLogger({ pretty: true });

const MENU = 'Pizza: $10, Salad: $5, Ice Cream: $3, Coffee: $2';

// --- Kuralle Runtime with restaurant agents ---
const runtime = new Runtime({
  agents: [
    {
      id: 'greeter',
      name: 'Restaurant Greeter',
      model: openai('gpt-4o-mini'),
      instructions: `You are a friendly restaurant receptionist. The menu is: ${MENU}

Your jobs are to:
1. Greet the caller warmly
2. Understand if they want to make a reservation or order takeaway
3. Guide them to the right department using handoffs

Always be polite and helpful. If the customer asks about something outside
your scope, let them know what you can help with.`,
      tools: {
        updateName: tool({
          description: 'Save the customer name. Confirm spelling first.',
          inputSchema: z.object({
            name: z.string().describe('The customer name'),
          }),
          execute: async ({ name }) => `Customer name saved: ${name}`,
        }),
        updatePhone: tool({
          description: 'Save the customer phone number. Confirm the number first.',
          inputSchema: z.object({
            phone: z.string().describe('The customer phone number'),
          }),
          execute: async ({ phone }) => `Phone number saved: ${phone}`,
        }),
      },
      handoffs: ['reservation', 'takeaway'],
    },
    {
      id: 'reservation',
      name: 'Reservation Agent',
      model: openai('gpt-4o-mini'),
      instructions: `You are a reservation agent at a restaurant.

Your jobs are to:
1. Ask for the reservation date and time
2. Collect the customer's name and phone number
3. Confirm all details with the customer
4. Complete the reservation

Be thorough but efficient. Always confirm details before saving.`,
      tools: {
        updateName: tool({
          description: 'Save the customer name. Confirm spelling first.',
          inputSchema: z.object({
            name: z.string().describe('The customer name'),
          }),
          execute: async ({ name }) => `Customer name saved: ${name}`,
        }),
        updatePhone: tool({
          description: 'Save the customer phone number. Confirm the number first.',
          inputSchema: z.object({
            phone: z.string().describe('The customer phone number'),
          }),
          execute: async ({ phone }) => `Phone number saved: ${phone}`,
        }),
        updateReservationTime: tool({
          description: 'Set the reservation time. Confirm with the customer first.',
          inputSchema: z.object({
            time: z.string().describe('The reservation date and time'),
          }),
          execute: async ({ time }) => `Reservation time set to: ${time}`,
        }),
        confirmReservation: tool({
          description: 'Confirm and finalize the reservation.',
          inputSchema: z.object({}),
          execute: async () => 'Reservation confirmed! Thank the customer and hand off to greeter.',
        }),
      },
      handoffs: ['greeter'],
    },
    {
      id: 'takeaway',
      name: 'Takeaway Agent',
      model: openai('gpt-4o-mini'),
      instructions: `You are a takeaway order agent at a restaurant. The menu is: ${MENU}

Your jobs are to:
1. Take the customer's order
2. Clarify any special requests
3. Confirm the complete order
4. Send them to checkout when ready

Be friendly and suggest items if the customer seems undecided.`,
      tools: {
        updateOrder: tool({
          description: 'Save or update the takeaway order.',
          inputSchema: z.object({
            items: z.array(z.string()).describe('The items in the order'),
          }),
          execute: async ({ items }) => `Order updated: ${items.join(', ')}`,
        }),
      },
      handoffs: ['greeter', 'checkout'],
    },
    {
      id: 'checkout',
      name: 'Checkout Agent',
      model: openai('gpt-4o-mini'),
      instructions: `You are a checkout agent at a restaurant. The menu is: ${MENU}

Your jobs are to:
1. Confirm the total expense with the customer
2. Collect payment information (name, phone, card details)
3. Process the payment
4. Thank the customer

Collect card details step by step: number, expiry, then CVV.
Always confirm before saving.`,
      tools: {
        updateName: tool({
          description: 'Save the customer name. Confirm spelling first.',
          inputSchema: z.object({
            name: z.string().describe('The customer name'),
          }),
          execute: async ({ name }) => `Customer name saved: ${name}`,
        }),
        updatePhone: tool({
          description: 'Save the customer phone number.',
          inputSchema: z.object({
            phone: z.string().describe('The customer phone number'),
          }),
          execute: async ({ phone }) => `Phone number saved: ${phone}`,
        }),
        confirmExpense: tool({
          description: 'Confirm the total expense with the customer.',
          inputSchema: z.object({
            expense: z.number().describe('The total expense in dollars'),
          }),
          execute: async ({ expense }) => `Expense confirmed: $${expense}`,
        }),
        updateCreditCard: tool({
          description: 'Save the credit card details. Confirm each field first.',
          inputSchema: z.object({
            number: z.string().describe('The credit card number'),
            expiry: z.string().describe('The expiry date (MM/YY)'),
            cvv: z.string().describe('The CVV code'),
          }),
          execute: async ({ number }) => {
            const masked = '*'.repeat(number.length - 4) + number.slice(-4);
            return `Credit card saved: ${masked}`;
          },
        }),
        confirmCheckout: tool({
          description: 'Finalize the checkout and process payment.',
          inputSchema: z.object({}),
          execute: async () => 'Payment processed successfully! Thank the customer.',
        }),
      },
      handoffs: ['greeter', 'takeaway'],
    },
  ],
  defaultAgentId: 'greeter',
  defaultModel: openai('gpt-4o-mini'),
});

// --- WebSocket Server ---
const server = new WebSocketAgentServer({ port: PORT });

server.onConnection(async (transport) => {
  console.log(`New connection: ${transport.id}`);

  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Welcome to our restaurant! How can I help you today? Would you like to make a reservation or place a takeaway order?',
    onKuralleHandoff: (from, to) => {
      console.log(`Agent handoff: ${from} → ${to}`);
    },
  });

  const session = await server.startSession(transport, voiceSession);

  session.on(voice.AgentSessionEventTypes.Close, () => {
    console.log(`Connection closed: ${transport.id}`);
  });
});

await server.listen();
console.log(`Restaurant Agent listening on ws://0.0.0.0:${PORT}`);
