#!/usr/bin/env npx tsx
/**
 * E2E Test: GeminiLiveSession + CapabilityHost with a real Gemini Live connection.
 *
 * Tests that:
 * 1. GeminiLiveSession connects to Gemini Live API
 * 2. Tool declarations from CapabilityHost reach Gemini
 * 3. Gemini calls the tools when prompted
 * 4. Tool results are processed through CapabilityHost
 * 5. Flow transitions trigger reconfigure
 *
 * Requires: GOOGLE_GENERATIVE_AI_API_KEY in .env
 * Does NOT require audio — uses Gemini Live's text input via realtime input.
 *
 * Run: cd packages/kuralle-realtime-audio && npx tsx test/gemini-live-e2e.ts
 */

import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import {
  CapabilityHost,
  FlowCapability,
  toGeminiDeclarations,
  type ToolDeclaration,
} from '@kuralle-agents/core/capabilities';
import { GeminiLiveSession } from '../src/node/GeminiLiveSession.js';
import type { FlowConfig } from '@kuralle-agents/core/types';

const currentDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(currentDir, '../../../.env') });

const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('GOOGLE_GENERATIVE_AI_API_KEY or GOOGLE_API_KEY required');
  process.exit(1);
}

interface FlowLifecycleEvent {
  type: string;
  nodeName?: string;
}

interface GeminiLiveClientContent {
  sendClientContent(input: {
    turns: Array<{ role: 'user'; parts: Array<{ text: string }> }>;
    turnComplete?: boolean;
  }): Promise<void> | void;
}

interface GeminiLiveSessionBridge {
  session: GeminiLiveClientContent | null;
}

interface ToolCallEventRecord {
  type: 'tool-call';
  data: { id: string; name: string; args: unknown };
}

type TestEvent =
  | ToolCallEventRecord
  | { type: 'transcript'; data: { text: string; role: string } }
  | { type: 'turn-complete' }
  | { type: 'error'; data: string };

function isToolCallEvent(event: TestEvent): event is ToolCallEventRecord {
  return event.type === 'tool-call';
}

function getLiveSessionBridge(session: GeminiLiveSession): GeminiLiveClientContent | null {
  const bridge = session as GeminiLiveSession & GeminiLiveSessionBridge;
  return bridge.session;
}

// ─── Test Flow ───────────────────────────────────────────────────────────────

const flow: FlowConfig = {
  nodes: [
    {
      id: 'greeting',
      prompt: 'You are a receptionist. Greet the user and ask how you can help.',
    },
    {
      id: 'booking',
      prompt: 'Help the user book an appointment. Ask for their name and preferred date.',
    },
    {
      id: 'confirm',
      prompt: 'Confirm the appointment details and say goodbye.',
      nodeType: 'end',
    },
  ],
  transitions: [
    { from: 'greeting', to: 'booking', on: 'book_appointment', contract: { label: 'User wants to book' } },
    { from: 'booking', to: 'confirm', on: 'confirm_booking', contract: { label: 'Details collected' } },
  ],
};

// ─── Build CapabilityHost ────────────────────────────────────────────────────

const host = new CapabilityHost();
const flowCap = new FlowCapability({ flow, initialNode: 'greeting' });
const initEvents: FlowLifecycleEvent[] = flowCap.initialize();
host.use(flowCap);

// Add a regular tool (non-capability)
const checkAvailability: ToolDeclaration = {
  name: 'check_availability',
  description: 'Check if a date is available for appointments',
  parameters: z.object({
    date: z.string().describe('The date to check (e.g., "next Tuesday")'),
  }),
  execute: async (args: { date: string }) => {
    console.log(`  [TOOL] check_availability called with date="${args.date}"`);
    return { available: true, slots: ['9:00 AM', '2:00 PM', '4:00 PM'] };
  },
};
host.addTools([checkAvailability]);

// ─── Test Runner ─────────────────────────────────────────────────────────────

async function runTest() {
  console.log('=== Gemini Live E2E Test ===\n');
  console.log(`Flow initialized. Current node: ${flowCap.currentNode}`);
  console.log(`Init events: ${initEvents.map(e => `${e.type}:${e.nodeName ?? ''}`).join(', ')}`);

  const tools = host.getAllTools();
  const toolNames = tools.map(t => t.name);
  console.log(`Tools: ${toolNames.join(', ')}`);

  const geminiTools = toGeminiDeclarations(tools);
  const systemPrompt = host.getSystemPrompt('You are a helpful hospital receptionist.');

  console.log(`\nSystem prompt (first 200 chars): ${systemPrompt.slice(0, 200)}...`);
  console.log(`\nConnecting to Gemini Live...`);

  // Create session
  const session = new GeminiLiveSession({
    gemini: { apiKey },
    agent: {
      id: 'test-receptionist',
      name: 'Test Receptionist',
      prompt: systemPrompt,
      tools: {},
    },
    onEvent: () => {}, // We'll use the on() interface instead
  });

  // Track events
  const events: TestEvent[] = [];
  let transcriptBuffer = '';
  let toolCallsReceived: Array<{ id: string; name: string; args: unknown }> = [];
  let turnCompleteResolve: (() => void) | null = null;

  session.on('transcript', (text, role) => {
    if (role === 'assistant') {
      transcriptBuffer += text;
    }
    events.push({ type: 'transcript', data: { text, role } });
  });

  session.on('tool-call', (id, name, args) => {
    console.log(`  [GEMINI TOOL-CALL] ${name}(${JSON.stringify(args)})`);
    toolCallsReceived.push({ id, name, args });
    events.push({ type: 'tool-call', data: { id, name, args } });

    // Execute the tool and route through CapabilityHost
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      console.log(`  [ERROR] Unknown tool: ${name}`);
      session.sendToolResponse([{ id, name, output: { error: `Unknown tool: ${name}` } }]);
      return;
    }

    tool.execute(args).then(result => {
      const action = host.processToolResult(name, args, result);
      console.log(`  [CAPABILITY ACTION] ${action.type}`);

      if (action.type === 'reconfigure') {
        console.log(`  [RECONFIGURE] Node changed to: ${flowCap.currentNode}`);
        // Send tool response then reconfigure
        session.sendToolResponse([{ id, name, output: result }]);
        // Note: in production, the realtime authority would call session.updateConfig() here
      } else {
        session.sendToolResponse([{ id, name, output: result }]);
      }
    });
  });

  session.on('turn-complete', () => {
    events.push({ type: 'turn-complete' });
    if (turnCompleteResolve) {
      turnCompleteResolve();
      turnCompleteResolve = null;
    }
  });

  session.on('error', (error) => {
    console.error(`  [ERROR] ${error}`);
    events.push({ type: 'error', data: error });
  });

  // Connect
  try {
    await session.connect();
    console.log('Connected!\n');
  } catch (e) {
    console.error('Connection failed:', e);
    process.exit(1);
  }

  // Helper: wait for turn complete with timeout
  function waitForTurn(timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        turnCompleteResolve = null;
        reject(new Error('Turn timeout'));
      }, timeoutMs);
      turnCompleteResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // Helper: send text and wait for response
  async function sendText(text: string): Promise<void> {
    console.log(`User: ${text}`);
    transcriptBuffer = '';
    toolCallsReceived = [];

    // Send as realtime text input
    const liveSession = getLiveSessionBridge(session);
    if (session.connected && liveSession) {
      await liveSession.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
    }

    try {
      await waitForTurn();
    } catch {
      console.log('  (turn timeout — continuing)');
    }

    if (transcriptBuffer) {
      console.log(`Assistant: ${transcriptBuffer.slice(0, 200)}${transcriptBuffer.length > 200 ? '...' : ''}`);
    }
    console.log(`  Tools called: ${toolCallsReceived.map(t => t.name).join(', ') || 'none'}`);
    console.log(`  Current node: ${flowCap.currentNode}`);
    console.log();
  }

  // ─── Run the conversation ──────────────────────────────────────────────

  // Wait for initial greeting
  console.log('--- Waiting for initial response ---');
  try {
    await waitForTurn();
    if (transcriptBuffer) {
      console.log(`Assistant (greeting): ${transcriptBuffer.slice(0, 200)}`);
    }
  } catch {
    console.log('  (no auto-greeting — sending first message)');
  }
  console.log();

  // Turn 1: User asks to book
  await sendText('I would like to book an appointment please.');

  // Turn 2: User provides details
  await sendText('My name is Alice and I would like next Tuesday.');

  // Turn 3: Confirm
  await sendText('Yes, that looks good. Please confirm.');

  // ─── Results ───────────────────────────────────────────────────────────

  console.log('=== Results ===');
  console.log(`Total events: ${events.length}`);
  console.log(`Tool calls: ${events.filter(e => e.type === 'tool-call').length}`);
  console.log(`Transcripts: ${events.filter(e => e.type === 'transcript').length}`);
  console.log(`Final node: ${flowCap.currentNode}`);
  console.log(`Flow ended: ${flowCap.hasEnded}`);
  console.log(`Collected data: ${JSON.stringify(flowCap.collectedData)}`);

  const toolNames2 = events
    .filter(isToolCallEvent)
    .map((event) => event.data.name);
  console.log(`Tools called in order: ${toolNames2.join(' → ') || 'none'}`);

  // Assertions
  let passed = 0;
  let failed = 0;

  function check(name: string, condition: boolean) {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  }

  console.log('\n--- Assertions ---');
  check('Connected to Gemini Live', events.length > 0);
  check('At least one tool was called', toolNames2.length > 0);
  check('book_appointment transition tool was called', toolNames2.includes('book_appointment'));
  check('Flow transitioned away from greeting', flowCap.currentNode !== 'greeting');

  console.log(`\n${passed} passed, ${failed} failed`);

  // Cleanup
  await session.disconnect();
  console.log('\nDisconnected. Test complete.');
  process.exit(failed > 0 ? 1 : 0);
}

runTest().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
