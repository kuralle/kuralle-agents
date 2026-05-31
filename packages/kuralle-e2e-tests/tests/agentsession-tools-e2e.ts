#!/usr/bin/env npx tsx
/**
 * E2E: AgentSession direct transport with one agent and multiple tools.
 *
 * Run:
 *   npx tsx packages/kuralle-e2e-tests/tests/agentsession-tools-e2e.ts
 */

import { initializeLogger, llm, voice } from '@livekit/agents';
import { z } from 'zod';
import {
  requireGeminiApiKey,
  runDirectAgentSessionScenario,
} from './agentsession_direct_harness.js';

initializeLogger({ pretty: true, level: 'warn' });

const apiKey = requireGeminiApiKey();

const agent = new voice.Agent({
  instructions: [
    'You are a concise voice assistant with tools.',
    'Always call check_weather when the user asks about weather.',
    'Always call get_time when the user asks about the time.',
    'If the user says "there", use the most recent city from the conversation.',
    'Keep replies to one or two short sentences.',
  ].join('\n'),
  tools: {
    check_weather: llm.tool({
      description: 'Check current weather for a city.',
      parameters: z.object({
        city: z.string().describe('City name'),
      }),
      execute: async ({ city }) => {
        console.log(`[tool] check_weather city=${city}`);
        return {
          city,
          temperature: 22,
          unit: 'celsius',
          condition: 'partly cloudy',
        };
      },
    }),
    get_time: llm.tool({
      description: 'Get the current time in a timezone.',
      parameters: z.object({
        timezone: z.string().describe('IANA timezone, for example Asia/Tokyo'),
      }),
      execute: async ({ timezone }) => {
        console.log(`[tool] get_time timezone=${timezone}`);
        return {
          timezone,
          time: new Date().toLocaleTimeString('en-US', { timeZone: timezone }),
        };
      },
    }),
  },
});

async function main(): Promise<void> {
  let exitCode = 1;
  try {
    const { trace, turnResults, tools } = await runDirectAgentSessionScenario({
      title: 'AgentSession direct transport: single agent tools E2E',
      agent,
      apiKey,
      portBase: 19500,
      turns: [
        {
          label: 'weather_tokyo',
          fixtureName: 'mt_weather_tokyo.pcm',
          expectedTools: ['check_weather'],
          waitForPostToolAudio: true,
        },
        {
          label: 'time_there',
          fixtureName: 'mt_time_there.pcm',
          expectedTools: ['get_time'],
          waitForPostToolAudio: true,
        },
      ],
    });

    const passed = turnResults.every((turn) => turn.chunks > 0)
      && tools.includes('check_weather')
      && tools.includes('get_time');

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
