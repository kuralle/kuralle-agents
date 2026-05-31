/**
 * SIP Voice Agent on Fly.io — createRuntime + native Gemini Live over SIP/RTP.
 *
 * Requires: GOOGLE_GENERATIVE_AI_API_KEY
 */

import http from 'node:http';
import { initializeLogger } from '@livekit/agents';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import { GeminiLiveSession } from '@kuralle-agents/realtime-audio';
import { SIPAgentServer } from '@kuralle-agents/livekit-plugin-transport-sip';
import { wireTools, createScenarioRuntime } from '../_shared/voice/scenarios.mjs';

initializeLogger({ pretty: true, level: 'info' });

const SIP_PORT = parseInt(process.env.SIP_PORT || '5060', 10);
const HTTP_PORT = parseInt(process.env.PORT || '3000', 10);
const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) { console.error('Set GOOGLE_GENERATIVE_AI_API_KEY'); process.exit(1); }

const LOCAL_ADDRESS = process.env.SIP_ADDRESS || '0.0.0.0';
const model = google('gemini-3-flash-preview');

const wired = wireTools({
  check_weather: {
    description: 'Check the current weather for a city',
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, temperature: 22, condition: 'partly cloudy', humidity: 65 }),
  },
  lookup_order: {
    description: 'Look up an order by ID',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => (
      orderId.includes('123')
        ? { orderId, status: 'shipped', tracking: '1Z999AA1', eta: 'Tomorrow by 5pm' }
        : { orderId, status: 'processing', eta: '2-3 business days' }
    ),
  },
});

const runtime = createScenarioRuntime(model, 'single');

const voiceAgent = {
  id: 'support',
  name: 'Customer Support',
  prompt: [
    'You are a friendly customer support agent answering phone calls.',
    'Keep responses to 1-2 sentences — this is a phone call.',
    'Use check_weather when asked about weather.',
    'Use lookup_order when asked about order status.',
  ].join('\n'),
  voice: 'Kore',
  tools: wired.tools,
};

const gemini = { apiKey, model: 'gemini-2.5-flash-native-audio-preview-12-2025' };

const sipServer = new SIPAgentServer({
  localAddress: LOCAL_ADDRESS,
  sipPort: SIP_PORT,
  rtpPortStart: 10000,
  codec: 'PCMU',
});

let activeCalls = 0;

sipServer.onCall(async (_transport, callId) => {
  activeCalls++;
  console.log(`[${callId}] Incoming SIP call (active: ${activeCalls})`);

  await sipServer.startNativeSession(callId, {
    runtime,
    agentId: voiceAgent.id,
    createModelClient: () => new GeminiLiveSession({
      gemini,
      agent: voiceAgent,
      onEvent: (event) => {
        if (event.type === 'transcript' && event.role === 'user') {
          console.log(`[${callId}] User: "${event.text?.slice(0, 120)}"`);
        }
      },
    }),
  });

  console.log(`[${callId}] Native session started`);
});

await sipServer.listen();
console.log(`SIP voice agent listening on UDP ${LOCAL_ADDRESS}:${SIP_PORT}`);

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    transport: 'sip',
    sipPort: SIP_PORT,
    activeCalls,
    uptime: process.uptime(),
  }));
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`Health check HTTP on port ${HTTP_PORT}`);
  console.log('Pipeline: SIP/RTP → VoiceCallSession + GeminiLiveSession + createRuntime');
});
