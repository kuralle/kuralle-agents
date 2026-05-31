import type { DeployMode } from './deploy-types.js';

export function createServerCode(mode: DeployMode): string {
  if (mode === 'agentsession') return createAgentSessionServerCode();
  return createTransportServerCode();
}

function createTransportServerCode(): string {
  return String.raw`
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createRuntime } from '@kuralle-agents/core';
import { voiceAgentToRuntimeAgent, GeminiLiveSession, VoiceCallSession } from '@kuralle-agents/realtime-audio';
import { bridgeWebSocketToRealtimeTransport } from '@kuralle-agents/livekit-plugin-transport-ws';

const PORT = 3000;
const READY_TOKEN = process.env.READY_TOKEN ?? '';
const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.error('Missing GOOGLE_API_KEY');
  process.exit(1);
}

const agent = {
  id: 'assistant',
  name: 'Sandbox Voice Assistant',
  description: 'A Gemini Live voice assistant running in a Vercel Sandbox',
  prompt: [
    'You are a friendly voice assistant running inside an ephemeral Vercel Sandbox.',
    'Wait for the caller to speak first.',
    'Keep responses to one or two short sentences.',
  ].join('\n'),
  voice: 'Kore',
};

const coreAgents = [voiceAgentToRuntimeAgent(agent)];
const runtime = createRuntime({
  agents: coreAgents,
  defaultAgentId: agent.id,
  voiceMode: true,
});

const gemini = { apiKey, model: 'gemini-3.1-flash-live-preview' };

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/__kuralle_health' && url.searchParams.get('readyToken') === READY_TOKEN) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      agent: 'kuralle-gemini-live',
      readyToken: READY_TOKEN,
      pid: process.pid,
      uptime: process.uptime(),
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', agent: 'kuralle-gemini-live', websocket: true }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const client = url.searchParams.get('client') ?? 'browser';
  const connectedAt = Date.now();
  const sessionId = 'sandbox-' + connectedAt + '-' + Math.random().toString(16).slice(2);

  let inboundChunks = 0;
  let inboundBytes = 0;
  let outboundChunks = 0;
  let outboundBytes = 0;
  let finished = false;
  let handle = null;

  const finish = async (reason) => {
    if (finished) return;
    finished = true;
    const event = {
      sessionId,
      client,
      reason,
      durationMs: Date.now() - connectedAt,
      inboundChunks,
      inboundBytes,
      outboundChunks,
      outboundBytes,
    };
    console.log('__KURALLE_SESSION_ENDED__ ' + JSON.stringify(event));
    if (handle) {
      try {
        const toStop = handle;
        handle = null;
        await toStop.stop();
      } catch (err) {
        console.error('[session] stop error ' + (err instanceof Error ? err.message : String(err)));
      }
    }
  };

  console.log('[ws] connected session=' + sessionId + ' client=' + client);
  ws.send(JSON.stringify({
    type: 'session_started',
    sessionId,
    config: { sampleRate: 24000, numChannels: 1, encoding: 'pcm_s16le' },
  }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      inboundChunks += 1;
      inboundBytes += data.byteLength;
      if (inboundChunks === 1) {
        console.log('[ws] first inbound binary session=' + sessionId + ' bytes=' + data.byteLength);
      } else if (inboundChunks % 100 === 0) {
        console.log('[ws] inbound binary progress session=' + sessionId + ' chunks=' + inboundChunks + ' bytes=' + inboundBytes);
      }
      return;
    }

    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'end_session') {
        ws.close(1000, 'client end_session');
      }
    } catch {
      // Ignore non-protocol text frames.
    }
  });

  ws.on('close', () => {
    void finish('ws-close');
  });
  ws.on('error', (err) => {
    console.error('[ws] error session=' + sessionId + ' ' + err.message);
    void finish('ws-error');
  });

  const baseTransport = bridgeWebSocketToRealtimeTransport(ws, { sessionId });
  const transport = {
    sendAudio(data) {
      outboundChunks += 1;
      outboundBytes += data.byteLength;
      if (outboundChunks === 1) {
        console.log('[ws] first outbound binary session=' + sessionId + ' bytes=' + data.byteLength + ' ms=' + (Date.now() - connectedAt));
      } else if (outboundChunks % 100 === 0) {
        console.log('[ws] outbound binary progress session=' + sessionId + ' chunks=' + outboundChunks + ' bytes=' + outboundBytes);
      }
      baseTransport.sendAudio(data);
    },
    onAudio(handler) {
      baseTransport.onAudio(handler);
    },
    onClose(handler) {
      baseTransport.onClose(handler);
    },
    close() {
      baseTransport.close();
    },
    onInterrupted(handler) {
      baseTransport.onInterrupted?.(handler);
    },
    clearAudioBuffer() {
      baseTransport.clearAudioBuffer?.();
    },
  };

  const modelClient = new GeminiLiveSession({
    gemini,
    agent,
    onEvent: (event) => {
      const dt = Date.now() - connectedAt;
      if (event.type === 'transcript') {
        console.log('[gemini +' + dt + 'ms] ' + event.role + ': ' + event.text);
      } else if (event.type === 'turn-complete') {
        console.log('[gemini +' + dt + 'ms] turn-complete');
      } else if (event.type === 'error') {
        console.log('[gemini +' + dt + 'ms] ERROR: ' + event.error);
      } else if (event.type === 'interrupted') {
        console.log('[gemini +' + dt + 'ms] interrupted');
      } else {
        console.log('[gemini +' + dt + 'ms] ' + event.type);
      }
    },
  });

  modelClient.on('disconnected', () => {
    void finish('model-disconnected');
  });
  modelClient.on('error', (err) => {
    console.error('[model] error session=' + sessionId + ' ' + err);
  });

  try {
    handle = new VoiceCallSession({
      runtime,
      modelClient,
      transport,
      sessionId,
    });
    await handle.start();
    console.log('[session] active session=' + sessionId + ' callId=' + handle.callId);
  } catch (err) {
    console.error('[session] start failed session=' + sessionId + ' ' + (err instanceof Error ? err.stack : String(err)));
    try {
      ws.close(4000, 'Session failed');
    } catch {
      // Ignore close errors.
    }
    await finish('start-failed');
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('Kuralle + Gemini Live running on port ' + PORT);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  httpServer.close(() => process.exit(0));
});
`;
}

function createAgentSessionServerCode(): string {
  return String.raw`
import http from 'node:http';
import { initializeLogger, voice, llm } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { z } from 'zod';
import {
  WebSocketAgentServer,
  WebSocketTransportAdapter,
} from '@kuralle-agents/livekit-plugin-transport-ws';

const PORT = 3000;
const READY_TOKEN = process.env.READY_TOKEN ?? '';
const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.error('Missing GOOGLE_API_KEY');
  process.exit(1);
}

initializeLogger({ pretty: true, level: 'warn' });

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/__kuralle_health' && url.searchParams.get('readyToken') === READY_TOKEN) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      agent: 'kuralle-gemini-live',
      mode: 'agentsession-direct',
      readyToken: READY_TOKEN,
      pid: process.pid,
      uptime: process.uptime(),
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', agent: 'kuralle-gemini-live', mode: 'agentsession-direct', websocket: true }));
});

const { WebSocketServer } = await import('ws');
const wss = new WebSocketServer({ server: httpServer });
const agentServer = new WebSocketAgentServer();

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const client = url.searchParams.get('client') ?? 'browser';
  const sessionId = 'sandbox-as-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  const adapter = new WebSocketTransportAdapter(ws, {
    id: sessionId,
    sampleRate: 24000,
    numChannels: 1,
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'end_of_audio') {
        adapter.audioInput.endOfAudio();
      } else if (msg.type === 'end_session') {
        ws.close(1000, 'client end_session');
      }
    } catch {
      // Ignore non-protocol text frames.
    }
  });

  const model = new google.beta.realtime.RealtimeModel({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    voice: 'Kore',
    apiKey,
  });

  const agent = new voice.Agent({
    instructions: [
      'You are a friendly voice assistant running in an ephemeral Vercel Sandbox.',
      'Keep responses to one or two short sentences.',
      'Use check_weather when asked about weather.',
      'Use get_time when asked about time.',
      'If the user says "there", use the most recent city from the conversation.',
      'IMPORTANT: Always use tools when the user asks about weather or time.',
    ].join('\\n'),
    tools: {
      check_weather: llm.tool({
        description: 'Check the current weather for a city',
        inputSchema: z.object({ city: z.string().describe('City name') }),
        execute: async ({ city }) => {
          console.log('[tool] check_weather city=' + city);
          return { city, temperature: 22, unit: 'celsius', condition: 'partly cloudy' };
        },
      }),
      get_time: llm.tool({
        description: 'Get the current time in a timezone',
        inputSchema: z.object({ timezone: z.string().describe('Timezone like Asia/Tokyo') }),
        execute: async ({ timezone }) => {
          console.log('[tool] get_time timezone=' + timezone);
          try {
            return { timezone, time: new Date().toLocaleTimeString('en-US', { timeZone: timezone }) };
          } catch {
            return { timezone, time: new Date().toLocaleTimeString('en-US') };
          }
        },
      }),
    },
  });

  console.log('[ws] connected session=' + sessionId + ' client=' + client);

  try {
    const agentSession = await agentServer.startRealtimeSession(adapter, {
      model,
      agent,
      maxToolSteps: 5,
      sessionId,
      onSessionEnd: (reason) => {
        const event = { sessionId, client, mode: 'agentsession-direct', reason };
        console.log('__KURALLE_SESSION_ENDED__ ' + JSON.stringify(event));
        model.close().catch(() => {});
      },
    });

    agentSession.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) console.log('[transcript] ' + ev.transcript);
    });
    agentSession.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
      for (const call of ev.functionCalls) {
        console.log('[tool done] ' + call.name);
      }
    });
    agentSession.on(voice.AgentSessionEventTypes.Error, (ev) => {
      console.error('[session error]', ev.error);
    });

    console.log('[session] active agentsession session=' + sessionId);
  } catch (err) {
    console.error('[session] start failed session=' + sessionId + ' ' + (err instanceof Error ? err.message : String(err)));
    model.close().catch(() => {});
    try { ws.close(4000, 'Failed'); } catch {}
  }
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('Kuralle AgentSession direct on port ' + PORT);
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  for (const client of wss.clients) {
    try { client.close(1000, 'shutdown'); } catch {}
  }
  httpServer.close(() => process.exit(0));
});
`;
}
