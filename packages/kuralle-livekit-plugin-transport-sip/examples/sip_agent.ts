/**
 * SIP Voice Agent - Simple example showing how to receive SIP calls
 *
 * This example shows how to run an Kuralle voice agent that receives SIP calls.
 *
 * Usage:
 *   bun run build
 *   npx tsx examples/sip_agent.ts
 *
 * Configure your SIP softphone:
 *   Domain: 127.0.0.1 (or your IP)
 *   Username: (optional, for REGISTER)
 *   Password: (optional, for REGISTER)
 *   Transport: UDP
 *   Port: 5060
 *
 * Then make a call from your softphone to start the agent.
 */
import { SIPAgentServer } from '../src/index.js';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger } from '@livekit/agents';

const LOCAL_ADDRESS = '0.0.0.0'; // Change to your IP
const SIP_PORT = 5060;
const RTP_PORT_START = 10000;

// Create Kuralle Runtime with LLM configured
const runtime = new Runtime({
  agents: [
    {
      id: 'assistant',
      name: 'Voice Assistant',
      model: openai('gpt-4o-mini'),
      instructions: `You are a helpful voice assistant.

Guidelines:
- Speak naturally and conversationally
- Keep responses concise (1-2 sentences when possible)
- If you need to collect information, ask specific questions
- Be friendly and professional`,
    },
  ],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});
initializeLogger({ pretty: true });

async function main() {
  console.log('Starting SIP Voice Agent Server');
  console.log(`Listening on ${LOCAL_ADDRESS}:${SIP_PORT}`);
  console.log('');

  // Create SIP server
  const server = new SIPAgentServer({
    localAddress: LOCAL_ADDRESS,
    sipPort: SIP_PORT,
    rtpPortStart: RTP_PORT_START,
    codec: 'PCMU', // G.711 μ-law
  });

  // Handle incoming calls
  server.onCall(async (transport, callId) => {
    console.log(`[Call ${callId}] Incoming call`);
    console.log(`[Call ${callId}] RTP port: ${server.getRtpPort(callId)}`);

    try {
      // Create voice session with Gemini STT/TTS
      const voiceSession = new KuralleVoiceSession({
        runtime: runtime, // LLM comes from runtime!
        stt: new GeminiLiveSTT(),
        tts: new GeminiLiveTTS(),
        greeting: 'Hello! Thank you for calling. How can I help you today?',
      });

      // Start session
      await server.startSession(callId, voiceSession);

      console.log(`[Call ${callId}] Session started`);

    } catch (error) {
      console.error(`[Call ${callId}] Error:`, error);
    }
  });

  // Start SIP server
  await server.listen();

  console.log('');
  console.log('SIP Voice Agent Server running');
  console.log('');
  console.log(`Test with a SIP softphone (Linphone, Zoiper, MicroSIP):`);
  console.log(`  - Address: ${LOCAL_ADDRESS}:${SIP_PORT}`);
  console.log(`  - No username/password required for basic INVITE`);
  console.log(`  - Send INVITE to start the agent`);
  console.log('');
  console.log('Agent will greet you and respond to what you say!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
