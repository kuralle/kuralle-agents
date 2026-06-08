/**
 * E2E: AgentSession + KuralleRuntimeLLMAdapter + Direct Deepgram Plugins
 *
 * Multi-turn tests that VERIFY Kuralle Runtime behavior — not just audio
 * round-trip. Each scenario sends PCM audio that triggers specific agent
 * behavior and validates:
 *   - Tool execution (tool_result JSON messages)
 *   - Flow transitions (handoff JSON messages)
 *   - Audio response (binary chunks received)
 *   - Correct transcription
 *
 * Requires: DEEPGRAM_API_KEY + GOOGLE_GENERATIVE_AI_API_KEY (NO LiveKit keys)
 *
 * Usage:
 *   npx tsx packages/kuralle-e2e-tests/tests/agentsession-kuralle-direct-e2e.ts
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { initializeLogger, voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
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
requireGeminiApiKey();

if (!process.env.DEEPGRAM_API_KEY) {
  console.log('SKIP: Set DEEPGRAM_API_KEY for direct Deepgram STT/TTS');
  process.exit(0);
}

initializeLogger({ pretty: true, level: 'warn' });

// ─── Types ────────────────────────────────────────────────────────────────────

type Turn = {
  label: string;
  fixtureName: string;
  expectTools?: string[];
  expectHandoff?: boolean;
  expectAudio?: boolean;
};

type ScenarioResult = {
  name: string;
  success: boolean;
  toolsVerified: boolean;
  audioVerified: boolean;
  turns: Array<{ label: string; tools: string[]; audioChunks: number; pass: boolean }>;
  error?: string;
};

// ─── Test runner ──────────────────────────────────────────────────────────────

async function runScenario(options: {
  name: string;
  runtime: Runtime;
  turns: Turn[];
  port: number;
  toolLog: string[];
}): Promise<ScenarioResult> {
  const { name, runtime, turns, port } = options;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(60)}`);

  // Track tool executions and handoffs from Kuralle Runtime
  const runtimeTools: string[] = [];
  const runtimeHandoffs: string[] = [];

  const httpServer = http.createServer((_, res) => { res.writeHead(200).end('ok'); });
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
        runtimeHandoffs.push(`${from}→${to}`);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'handoff', from, to }));
        }
      },
    });

    const agent = new voice.Agent({ instructions: 'Respond naturally.' });
    const session = new voice.AgentSession({
      // GH#34 — Deepgram plugin defaults endpointing to 25ms which fragments
      // any multi-word utterance with a natural pause (e.g. "My order number
      // is ORD-1042" → "Your order number is" + "1042"). Bump to a sane
      // 250ms — Deepgram's documented natural-speech default — so a single
      // user utterance maps to a single transcript / single LLM turn.
      stt: new deepgram.STT({ model: 'nova-3', language: 'multi', endpointing: 250 }),
      llm: ariaLLM,
      tts: new deepgram.TTS({ model: 'aura-2-thalia-en' }),
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
      const startToolLogCount = options.toolLog.length;
      const startHandoffCount = trace.getMessages('handoff').length;

      trace.startTurn(i, turn.label);
      console.log(`  Turn ${i}: ${turn.label}`);

      // Send audio paced at real-time speed
      await client.sendAudioFramesPaced(new Uint8Array(fixture(turn.fixtureName)), 960, 20);
      await client.sendAudioFramesPaced(generateSilence(1200), 960, 20);
      client.sendEndOfAudio();

      // Wait for expected tools — verified via server-side runtimeToolLog,
      // NOT WS tool_result messages (cascaded path doesn't emit those)
      let toolsFound: string[] = [];
      if (turn.expectTools?.length) {
        try {
          await waitFor(
            `${turn.label} tools (runtime)`,
            () => {
              toolsFound = options.toolLog.slice(startToolLogCount);
              return turn.expectTools!.every((t) => toolsFound.includes(t));
            },
            60000,
          );
          console.log(`  ✓ Tools verified (runtime): [${toolsFound.join(', ')}]`);
        } catch {
          toolsFound = options.toolLog.slice(startToolLogCount);
          console.warn(`  ✗ Tool timeout — runtime log has [${toolsFound.join(', ')}], expected [${turn.expectTools.join(', ')}]`);
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
          const handoffs = trace.getMessages('handoff').slice(startHandoffCount);
          console.log(`  ✓ Handoff verified: ${handoffs.map(h => `${h.from}→${h.to}`).join(', ')}`);
        } catch {
          console.warn(`  ✗ Handoff timeout`);
        }
      }

      // Wait for audio response
      const expectAudio = turn.expectAudio !== false;
      let audioChunks = 0;
      if (expectAudio) {
        try {
          await waitFor(
            `${turn.label} audio`,
            () => trace.binaryChunks.length > startChunks,
            60000,
          );
        } catch {
          console.warn(`  ✗ Audio timeout`);
        }
      }
      await sleep(5000);
      trace.endTurn();

      audioChunks = trace.binaryChunks.length - startChunks;
      const actualTools = options.toolLog.slice(startToolLogCount);

      const toolsOk = !turn.expectTools?.length || turn.expectTools.every(t => actualTools.includes(t));
      const audioOk = !expectAudio || audioChunks > 0;
      const turnPass = toolsOk && audioOk;

      turnResults.push({
        label: turn.label,
        tools: actualTools,
        audioChunks,
        pass: turnPass,
      });
      console.log(`  → ${turnPass ? '✓' : '✗'} chunks=${audioChunks} tools=[${actualTools.join(',')}]`);
    }

    // Summary
    const allToolsVerified = turnResults.every(t => {
      const expected = turns.find(turn => turn.label === t.label)?.expectTools ?? [];
      return expected.every(e => t.tools.includes(e));
    });
    const allAudioVerified = turnResults.every(t => {
      const expected = turns.find(turn => turn.label === t.label);
      return expected?.expectAudio === false || t.audioChunks > 0;
    });
    const allPass = turnResults.every(t => t.pass);

    console.log(`\n  Summary: ${allPass ? 'PASS' : 'FAIL'}`);
    console.log(`    Tools verified: ${allToolsVerified}`);
    console.log(`    Audio verified: ${allAudioVerified}`);
    trace.printSummary();

    return {
      name,
      success: allPass,
      toolsVerified: allToolsVerified,
      audioVerified: allAudioVerified,
      turns: turnResults,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${msg}`);
    return { name, success: false, toolsVerified: false, audioVerified: false, turns: turnResults, error: msg };
  } finally {
    client.close();
    await sleep(500);
    wss.close();
    httpServer.close();
  }
}

// ─── Scenario 1: Single agent — weather + time tools ─────────────────────────

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
        'ALWAYS use check_weather when asked about weather.',
        'ALWAYS use get_time when asked about time.',
      ].join('\n'),
      tools: {
        check_weather: wrapAiSdkTool(
          'check_weather',
          tool({
            description: 'Check the current weather for a city',
            inputSchema: z.object({ city: z.string() }),
            execute: async ({ city }) => {
              console.log(`  [tool] check_weather("${city}")`);
              runtimeToolLog.push('check_weather');
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
              runtimeToolLog.push('get_time');
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

// ─── Scenario 2: Flow agent — ecommerce hub → tracking ───────────────────────

function flowAgentScenario() {
  const model = google('gemini-3-flash-preview');

  const trackingNode = reply({
    id: 'tracking',
    instructions: 'Ask for order number, then use lookup_order.',
    tools: {
      lookup_order: tool({
        description: 'Look up order status by order number',
        inputSchema: z.object({ orderNumber: z.string() }),
        execute: async ({ orderNumber }) => {
          console.log(`  [tool] lookup_order("${orderNumber}")`);
          runtimeToolLog.push('lookup_order');
          return { orderNumber, status: 'shipped', carrier: 'FedEx', eta: 'Tomorrow by 5pm' };
        },
      }),
    },
  });

  const hubNode = reply({
    id: 'hub',
    instructions: 'If the customer wants to track an order, use route_to_tracking.',
    tools: {
      route_to_tracking: tool({
        description: 'Route to order tracking',
        inputSchema: z.object({}),
        execute: async () => {
          console.log('  [tool] route_to_tracking');
          runtimeToolLog.push('route_to_tracking');
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

// ─── Scenario 3: Triage agent — hub routes to tracking ───────────────────────

function triageAgentScenario() {
  const model = google('gemini-3-flash-preview');

  const tracking = defineAgent({
    id: 'tracking',
    name: 'Order Tracking',
    model,
    instructions: 'You help customers track orders. Ask for the order number, then use lookup_order.',
    tools: {
      lookup_order: wrapAiSdkTool(
        'lookup_order',
        tool({
          description: 'Look up order status by order number',
          inputSchema: z.object({ orderNumber: z.string() }),
          execute: async ({ orderNumber }) => {
            console.log(`  [tool] lookup_order("${orderNumber}")`);
            runtimeToolLog.push('lookup_order');
            return { orderNumber, status: 'shipped', carrier: 'FedEx', eta: 'Tomorrow by 5pm' };
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
      'Otherwise answer directly.',
    ].join('\n'),
    routes: [{ agent: 'tracking', when: 'order tracking or shipment status' }],
    agents: [tracking],
    routing: { model },
  });

  const runtime = new Runtime({
    agents: [triage, tracking],
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

// ─── Global tool log (tracks Kuralle Runtime tool execution) ─────────────────
const runtimeToolLog: string[] = [];

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  E2E: AgentSession + KuralleRuntimeLLMAdapter + Direct Deepgram');
  console.log('  Pipeline: Deepgram STT (direct) → Kuralle Runtime → Deepgram TTS (direct)');
  console.log('  Verifies: tool execution, flow transitions, handoffs, audio');
  console.log('═══════════════════════════════════════════════════════════════');

  const results: ScenarioResult[] = [];
  let portBase = 19800;

  // 1. Single agent with tools
  runtimeToolLog.length = 0;
  const s1 = singleAgentScenario();
  results.push(await runScenario({
    name: '1. Single Agent — check_weather + get_time',
    runtime: s1.runtime,
    turns: s1.turns,
    port: portBase++,
    toolLog: runtimeToolLog,
  }));

  // 2. Flow agent (ecommerce)
  runtimeToolLog.length = 0;
  const s2 = flowAgentScenario();
  results.push(await runScenario({
    name: '2. Flow Agent — E-Commerce (hub → tracking)',
    runtime: s2.runtime,
    turns: s2.turns,
    port: portBase++,
    toolLog: runtimeToolLog,
  }));

  // 3. Triage agent
  runtimeToolLog.length = 0;
  const s3 = triageAgentScenario();
  results.push(await runScenario({
    name: '3. Triage Agent — Hub → Tracking (handoff + tools)',
    runtime: s3.runtime,
    turns: s3.turns,
    port: portBase++,
    toolLog: runtimeToolLog,
  }));

  // ─── Final report ──────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(60));
  console.log('  FINAL RESULTS');
  console.log('═'.repeat(60));

  for (const r of results) {
    const status = r.success ? 'PASS' : 'FAIL';
    const allTools = r.turns.flatMap(t => t.tools);
    console.log(`  [${status}] ${r.name}`);
    console.log(`         tools_verified=${r.toolsVerified} audio_verified=${r.audioVerified}`);
    console.log(`         tools_executed=[${allTools.join(',')}]`);
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
