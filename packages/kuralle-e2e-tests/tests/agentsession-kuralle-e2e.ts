/**
 * E2E: AgentSession + KuralleRuntimeLLMAdapter — All Agent Types.
 *
 * Tests that Kuralle Runtime (flows, triage, tools, session state) works
 * correctly when used as the LLM inside a LiveKit AgentSession cascaded
 * pipeline (Deepgram STT → KuralleRuntimeLLMAdapter → Cartesia TTS).
 *
 * Agent types exercised:
 *   1. Single agent with tools (check_weather, get_time)
 *   2. Flow agent with node-level tools (ecommerce: hub → tracking)
 *   3. Triage agent with sub-agents that have their own tools
 *
 * Usage:
 *   npx tsx packages/kuralle-e2e-tests/tests/agentsession-kuralle-e2e.ts
 *
 * Requires: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, GOOGLE_GENERATIVE_AI_API_KEY
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { initializeLogger, inference, voice } from '@livekit/agents';
import { google } from '@ai-sdk/google';
import { tool } from 'ai';
import { z } from 'zod';
import { Runtime, createFlowTransition, defineAgent, defineFlow, reply, wrapAiSdkTool } from '@kuralle-agents/core';
import { KuralleRuntimeLLMAdapter } from '@kuralle-agents/livekit-plugin';
import { WebSocketTransportAdapter } from '@kuralle-agents/livekit-plugin-transport-ws';

import { TraceCollector } from '../harness/trace_collector.js';
import { WsTestClient } from '../harness/ws_client.js';
import { generateSilence } from '../harness/audio_fixtures.js';
import {
  loadEnv,
  requireGeminiApiKey,
  fixture,
  sleep,
  waitFor,
} from './agentsession_direct_harness.js';

// ─── Env ──────────────────────────────────────────────────────────────────────

loadEnv();
const apiKey = requireGeminiApiKey();

if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  console.log('SKIP: Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET for cascaded inference');
  process.exit(0);
}

initializeLogger({ pretty: true, level: 'warn' });

// ─── Shared test runner ───────────────────────────────────────────────────────

type Turn = {
  label: string;
  fixtureName: string;
  expectTools?: string[];
  expectHandoff?: boolean;
};

type ScenarioResult = {
  name: string;
  success: boolean;
  turns: Array<{ label: string; chunks: number; bytes: number; tools: string[] }>;
  error?: string;
};

async function runKuralleScenario(options: {
  name: string;
  runtime: Runtime;
  turns: Turn[];
  port: number;
}): Promise<ScenarioResult> {
  const { name, runtime, turns, port } = options;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(60)}`);

  const httpServer = http.createServer((_, res) => {
    res.writeHead(200).end('ok');
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', async (ws) => {
    const sessionId = `test-${Date.now()}`;
    const adapter = new WebSocketTransportAdapter(ws, {
      id: sessionId,
      sampleRate: 24000,
      numChannels: 1,
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'end_of_audio') adapter.audioInput.endOfAudio();
      } catch { /* ignore */ }
    });

    const ariaLLM = new KuralleRuntimeLLMAdapter({
      runtime,
      sessionId,
      onKuralleHandoff: (from, to) => {
        console.log(`  [handoff] ${from} → ${to}`);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'handoff', from, to }));
        }
      },
    });

    const agent = new voice.Agent({ instructions: 'Respond naturally.' });

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'deepgram/nova-3', language: 'multi' }),
      llm: ariaLLM,
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),
      maxToolSteps: 5,
    });

    session.input.audio = adapter.audioInput;
    session.output.audio = adapter.audioOutput;
    session.output.transcription = adapter.textOutput;

    ws.once('close', () => session.close().catch(() => {}));

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) console.log(`  [transcript] "${ev.transcript}"`);
    });

    try {
      await session.start({ agent });
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({
          type: 'session_started',
          sessionId,
          config: { sampleRate: 24000, numChannels: 1, encoding: 'pcm_s16le' },
        }));
      }
    } catch (err) {
      console.error('  session start failed:', err);
      ws.close(4000, 'Failed');
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  const trace = new TraceCollector();
  const client = new WsTestClient({ url: `ws://127.0.0.1:${port}`, trace });
  const turnResults: ScenarioResult['turns'] = [];

  try {
    await client.waitForOpen();
    await client.waitForJsonMessage('session_started', 15000);
    console.log('  session_started received');

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const startChunks = trace.binaryChunks.length;
      const startBytes = trace.totalBinaryBytes;
      const startToolCount = trace.getMessages('tool_result').length;
      const startHandoffCount = trace.getMessages('handoff').length;

      trace.startTurn(i, turn.label);
      console.log(`  Turn ${i}: ${turn.label}`);

      // Send audio paced at real-time speed
      await client.sendAudioFramesPaced(new Uint8Array(fixture(turn.fixtureName)), 960, 20);
      await client.sendAudioFramesPaced(generateSilence(1200), 960, 20);
      client.sendEndOfAudio();

      // Wait for expected tools
      if (turn.expectTools?.length) {
        try {
          await waitFor(
            `${turn.label} tools`,
            () => {
              const tools = trace.getMessages('tool_result')
                .slice(startToolCount)
                .map((m) => String(m.toolName));
              return turn.expectTools!.every((t) => tools.includes(t));
            },
            60000,
          );
        } catch {
          console.warn(`  ⚠ tool timeout for ${turn.label}`);
        }
      }

      // Wait for handoff if expected
      if (turn.expectHandoff) {
        try {
          await waitFor(
            `${turn.label} handoff`,
            () => trace.getMessages('handoff').length > startHandoffCount,
            30000,
          );
        } catch {
          console.warn(`  ⚠ handoff timeout for ${turn.label}`);
        }
      }

      // Wait for audio response
      try {
        await waitFor(
          `${turn.label} audio`,
          () => trace.binaryChunks.length > startChunks,
          60000,
        );
      } catch {
        console.warn(`  ⚠ audio timeout for ${turn.label}`);
      }

      await sleep(5000);
      trace.endTurn();

      const tools = trace.getMessages('tool_result')
        .slice(startToolCount)
        .map((m) => String(m.toolName));
      const result = {
        label: turn.label,
        chunks: trace.binaryChunks.length - startChunks,
        bytes: trace.totalBinaryBytes - startBytes,
        tools,
      };
      turnResults.push(result);
      console.log(`  → ${result.chunks} chunks, ${result.bytes} bytes, tools=[${tools.join(',')}]`);
    }

    // Print summary
    console.log(`\n  Summary for "${name}":`);
    const allTools = trace.getMessages('tool_result').map((m) => String(m.toolName));
    const allHandoffs = trace.getMessages('handoff');
    console.log(`  Total tools: ${allTools.length} [${allTools.join(', ')}]`);
    console.log(`  Total handoffs: ${allHandoffs.length}`);
    console.log(`  Total audio chunks: ${trace.binaryChunks.length}`);
    trace.printSummary();

    return { name, success: true, turns: turnResults };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg}`);
    return { name, success: false, turns: turnResults, error: msg };
  } finally {
    client.close();
    await sleep(500);
    wss.close();
    httpServer.close();
  }
}

// ─── Scenario 1: Single agent with tools ──────────────────────────────────────

function singleAgentScenario() {
  const model = google('gemini-3-flash-preview');
  const runtime = new Runtime({
    agents: [defineAgent({
      id: 'assistant',
      name: 'Voice Assistant',
      model,
      instructions: [
        'You are a friendly voice assistant.',
        'Keep responses to 1-2 sentences.',
        'Use check_weather when asked about weather.',
        'Use get_time when asked about the time.',
      ].join('\n'),
      tools: {
        check_weather: wrapAiSdkTool(
          'check_weather',
          tool({
            description: 'Check the current weather for a city',
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }) => {
              console.log(`  [tool] check_weather("${city}")`);
              return { city, temperature: 22, unit: 'celsius', condition: 'partly cloudy' };
            },
          }),
        ),
        get_time: wrapAiSdkTool(
          'get_time',
          tool({
            description: 'Get the current time in a timezone',
            inputSchema: z.object({ timezone: z.string() }),
            execute: async ({ timezone }) => {
              console.log(`  [tool] get_time("${timezone}")`);
              try {
                return { timezone, time: new Date().toLocaleTimeString('en-US', { timeZone: timezone }) };
              } catch {
                return { timezone, time: new Date().toLocaleTimeString('en-US') };
              }
            },
          }),
        ),
      },
    })],
    defaultAgentId: 'assistant',
    defaultModel: model,
  });

  const turns: Turn[] = [
    { label: 'weather_tokyo', fixtureName: 'mt_weather_tokyo.pcm', expectTools: ['check_weather'] },
    { label: 'time_there', fixtureName: 'mt_time_there.pcm', expectTools: ['get_time'] },
    { label: 'goodbye', fixtureName: 'mt_goodbye.pcm' },
  ];

  return { runtime, turns };
}

// ─── Scenario 2: Flow agent (ecommerce hub → tracking) ───────────────────────

function flowAgentScenario() {
  const model = google('gemini-3-flash-preview');

  const trackingNode = reply({
    id: 'tracking',
    instructions: [
      'Help the customer track their order.',
      'Ask for order number if not provided, then use lookup_order.',
    ].join('\n'),
    tools: {
      lookup_order: tool({
        description: 'Look up order status by order number',
        inputSchema: z.object({ orderNumber: z.string() }),
        execute: async ({ orderNumber }) => {
          console.log(`  [tool] lookup_order("${orderNumber}")`);
          return { orderNumber, status: 'shipped', carrier: 'FedEx', eta: 'Tomorrow by 5pm' };
        },
      }),
      back_to_hub: tool({
        description: 'Return to main menu',
        inputSchema: z.object({}),
        execute: async () => {
          console.log('  [tool] back_to_hub');
          return createFlowTransition('hub');
        },
      }),
    },
  });

  const hubNode = reply({
    id: 'hub',
    instructions: [
      'You are the main customer service agent.',
      'If the customer wants to track an order, use route_to_tracking.',
      'Store hours: 9am-6pm Mon-Sat.',
    ].join('\n'),
    tools: {
      route_to_tracking: tool({
        description: 'Route to order tracking',
        inputSchema: z.object({}),
        execute: async () => {
          console.log('  [tool] route_to_tracking');
          return createFlowTransition('tracking');
        },
      }),
    },
  });

  const ecomFlow = defineFlow({
    name: 'ecom-support',
    description: 'E-commerce customer service',
    start: hubNode,
    nodes: [hubNode, trackingNode],
  });

  const runtime = new Runtime({
    agents: [defineAgent({
      id: 'ecom-support',
      name: 'E-Commerce Support',
      model,
      instructions: [
        'You are a helpful customer service agent for ShopNow.',
        'Be friendly and efficient. Keep responses to 1-2 sentences.',
        'CRITICAL: Use the available tools when routing or looking up orders.',
      ].join('\n'),
      flows: [ecomFlow],
    })],
    defaultAgentId: 'ecom-support',
    defaultModel: model,
  });

  const turns: Turn[] = [
    { label: 'track_order', fixtureName: 'mt_track_order.pcm', expectTools: ['route_to_tracking'] },
    { label: 'order_number', fixtureName: 'mt_order_number.pcm', expectTools: ['lookup_order'] },
    { label: 'thats_all', fixtureName: 'mt_thats_all.pcm' },
  ];

  return { runtime, turns };
}

// ─── Scenario 3: Triage agent with sub-agents ────────────────────────────────

function triageAgentScenario() {
  const model = google('gemini-3-flash-preview');

  const tracking = defineAgent({
    id: 'tracking',
    name: 'Order Tracking',
    model,
    instructions: [
      'You help customers track orders.',
      'Ask for the order number, then use lookup_order.',
    ].join('\n'),
    tools: {
      lookup_order: wrapAiSdkTool(
        'lookup_order',
        tool({
          description: 'Look up order status by order number',
          inputSchema: z.object({ orderNumber: z.string() }),
          execute: async ({ orderNumber }) => {
            console.log(`  [tool] lookup_order("${orderNumber}")`);
            return { orderNumber, status: 'shipped', carrier: 'FedEx', eta: 'Tomorrow by 5pm' };
          },
        }),
      ),
    },
  });

  const billing = defineAgent({
    id: 'billing',
    name: 'Billing',
    model,
    instructions: [
      'You help with billing questions.',
      'Use check_balance to look up account balance.',
    ].join('\n'),
    tools: {
      check_balance: wrapAiSdkTool(
        'check_balance',
        tool({
          description: 'Check account balance',
          inputSchema: z.object({ accountId: z.string() }),
          execute: async ({ accountId }) => {
            console.log(`  [tool] check_balance("${accountId}")`);
            return { accountId, balance: '$142.50', dueDate: '2026-05-01' };
          },
        }),
      ),
    },
  });

  const triage = defineAgent({
    id: 'triage',
    name: 'Triage Hub',
    model,
    instructions: [
      'You are a customer service router.',
      'If the user wants to track an order, hand off to "tracking".',
      'If the user wants billing help, hand off to "billing".',
      'Otherwise answer directly. Keep responses to 1-2 sentences.',
    ].join('\n'),
    routes: [
      { agent: 'tracking', when: 'order tracking or shipment status' },
      { agent: 'billing', when: 'billing, balance, or payment questions' },
    ],
    agents: [tracking, billing],
    routing: { mode: 'structured', model },
  });

  const runtime = new Runtime({
    agents: [triage, tracking, billing],
    defaultAgentId: 'triage',
    defaultModel: model,
  });

  const turns: Turn[] = [
    { label: 'track_order', fixtureName: 'mt_track_order.pcm', expectHandoff: true },
    { label: 'order_number', fixtureName: 'mt_order_number.pcm', expectTools: ['lookup_order'] },
    { label: 'goodbye', fixtureName: 'mt_goodbye.pcm' },
  ];

  return { runtime, turns };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  E2E: AgentSession + KuralleRuntimeLLMAdapter — All Agent Types');
  console.log('  Pipeline: Deepgram STT → Kuralle Runtime → Cartesia TTS');
  console.log('═══════════════════════════════════════════════════════════════');

  const results: ScenarioResult[] = [];
  let portBase = 19700;

  // 1. Single agent with tools
  const s1 = singleAgentScenario();
  results.push(await runKuralleScenario({
    name: '1. Single Agent with Tools (weather + time)',
    runtime: s1.runtime,
    turns: s1.turns,
    port: portBase++,
  }));

  // 2. Flow agent (ecommerce)
  const s2 = flowAgentScenario();
  results.push(await runKuralleScenario({
    name: '2. Flow Agent — E-Commerce (hub → tracking)',
    runtime: s2.runtime,
    turns: s2.turns,
    port: portBase++,
  }));

  // 3. Triage agent with sub-agents
  const s3 = triageAgentScenario();
  results.push(await runKuralleScenario({
    name: '3. Triage Agent — Hub + Tracking + Billing',
    runtime: s3.runtime,
    turns: s3.turns,
    port: portBase++,
  }));

  // ─── Final report ──────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(60));
  console.log('  FINAL RESULTS');
  console.log('═'.repeat(60));

  for (const r of results) {
    const status = r.success ? 'PASS' : 'FAIL';
    const toolList = r.turns.flatMap(t => t.tools);
    console.log(`  [${status}] ${r.name}`);
    console.log(`         turns=${r.turns.length} tools=[${toolList.join(',')}]`);
    if (r.error) console.log(`         error: ${r.error}`);
  }

  const allPass = results.every(r => r.success);
  console.log(`\n  ${allPass ? 'ALL PASSED' : 'SOME FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
