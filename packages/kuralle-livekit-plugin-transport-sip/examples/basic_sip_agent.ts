/**
 * Basic voice agent over SIP/RTP using Kuralle.
 *
 * Accepts incoming SIP calls and runs a voice agent with G.711 mu-law codec.
 *
 * Usage:
 *   npx tsx examples/basic_sip_agent.ts
 *
 * The agent listens on SIP port 5060 and allocates RTP ports starting at 10000.
 * Connect from a SIP phone, softphone (Zoiper, X-Lite), or PBX (Asterisk).
 */
import { SIPAgentServer } from '@kuralle-agents/livekit-plugin-transport-sip';
import { createKuralleSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { initializeLogger, voice } from '@livekit/agents';

const runtime = new Runtime({
  agents: [
    {
      id: 'assistant',
      name: 'Acme Support Agent',
      model: openai('gpt-4o-mini'),
      instructions: `You are a customer service agent for Acme Corp.
        Be professional and helpful. Ask how you can assist the caller today.`,
    },
  ],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

initializeLogger({ pretty: true });

const server = new SIPAgentServer({
  localAddress: '0.0.0.0',
  sipPort: 5060,
  rtpPortStart: 10000,
  codec: 'PCMU',
});

server.onCall(async (_transport, callId) => {
  console.log(`Incoming call: ${callId}`);

  const voiceSession = createKuralleSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Thank you for calling Acme Corp. How can I help you today?',
  });

  const session = await server.startSession(callId, voiceSession);

  session.on(voice.AgentSessionEventTypes.Close, () => {
    console.log(`Call ${callId} ended`);
  });
});

await server.listen();
console.log('SIP Kuralle agent server listening on port 5060');
