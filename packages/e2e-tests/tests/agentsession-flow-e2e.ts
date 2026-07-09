#!/usr/bin/env npx tsx
/**
 * E2E: AgentSession direct transport with a flow-like LiveKit agent handoff.
 *
 * This is Path D using LiveKit's built-in llm.handoff() mechanism. Kuralle
 * LiveKitRealtimeAdapter flow integration is future work.
 *
 * Run:
 *   npx tsx packages/e2e-tests/tests/agentsession-flow-e2e.ts
 */

import { initializeLogger, llm, voice } from '@livekit/agents';
import { z } from 'zod';
import {
  requireGeminiApiKey,
  runDirectAgentSessionScenario,
} from './agentsession_direct_harness.js';

initializeLogger({ pretty: true, level: 'warn' });

const apiKey = requireGeminiApiKey();

const bookingAgent = new voice.Agent({
  id: 'booking_agent',
  instructions: [
    'You are a hospital appointment booking agent.',
    'When the user gives a department and date, call check_availability.',
    'Keep replies brief and confirm the available slot naturally.',
  ].join('\n'),
  tools: {
    check_availability: llm.tool({
      description: 'Check hospital appointment availability for a department and date.',
      parameters: z.object({
        department: z.string().describe('Hospital department'),
        date: z.string().describe('Requested appointment date'),
      }),
      execute: async ({ department, date }) => {
        console.log(`[tool] check_availability department=${department} date=${date}`);
        return {
          department,
          date,
          available: true,
          slots: ['9:00 AM', '11:00 AM', '2:00 PM'],
        };
      },
    }),
  },
});

const routingAgent = new voice.Agent({
  id: 'routing_agent',
  instructions: [
    'You are a hospital receptionist and routing agent.',
    'If the user wants to book or manage an appointment, immediately call transfer_to_booking.',
    'Do not collect booking details yourself.',
    'Keep replies brief.',
  ].join('\n'),
  tools: {
    transfer_to_booking: llm.tool({
      description: 'Transfer the caller to the appointment booking agent.',
      execute: async () => {
        console.log('[tool] transfer_to_booking');
        return llm.handoff({
          agent: bookingAgent,
          returns: 'I will help with the appointment booking now.',
        });
      },
    }),
  },
});

async function main(): Promise<void> {
  let exitCode = 1;
  try {
    const { trace, turnResults, tools } = await runDirectAgentSessionScenario({
      title: 'AgentSession direct transport: flow handoff E2E',
      agent: routingAgent,
      apiKey,
      portBase: 19600,
      turns: [
        {
          label: 'route_to_booking',
          fixtureName: 'turn1_book_appointment.pcm',
          expectedTools: ['transfer_to_booking'],
          requireAudio: false,
          waitForPostToolAudio: false,
        },
        {
          label: 'booking_details',
          fixtureName: 'mt_cardiology_tuesday.pcm',
          expectedTools: ['check_availability'],
          waitForPostToolAudio: true,
        },
      ],
    });

    const bookingDetails = turnResults.find((turn) => turn.label === 'booking_details');
    const passed = Boolean(bookingDetails && bookingDetails.chunks > 0)
      && tools.includes('transfer_to_booking')
      && tools.includes('check_availability');

    trace.printSummary();
    console.log(`FINAL: ${passed ? 'PASS' : 'FAIL'} tools=${tools.join(',')}`);
    exitCode = passed ? 0 : 1;
  } finally {
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
