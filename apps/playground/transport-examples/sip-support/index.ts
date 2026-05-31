/**
 * Customer Support Agent over SIP (VoIP)
 *
 * This example shows a customer support agent accessible via SIP/VoIP call.
 *
 * Usage:
 *   bun run sip-support
 *
 * Configure your SIP softphone:
 *   Domain: 127.0.0.1
 *   Username: (not required for basic INVITE)
 *   Transport: UDP
 *   Registrar: 127.0.0.1:5060
 */

import { SIPAgentServer } from '@kuralle-agents/livekit-plugin-transport-sip';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger, voice } from '@livekit/agents';

import { buildSupportRuntime, supportGreeting } from '../support-agent/index.js';

const LOCAL_ADDRESS = '127.0.0.1';
const SIP_PORT = 5060;
const RTP_PORT_START = 10000;
initializeLogger({ pretty: true });

const runtime = buildSupportRuntime(openai('gpt-4o-mini'));

async function main() {
  console.log(`Starting SIP Customer Support Server`);
  console.log(`Listening on ${LOCAL_ADDRESS}:${SIP_PORT}`);
  console.log(``);

  // Create SIP server
  const server = new SIPAgentServer({
    localAddress: LOCAL_ADDRESS,
    sipPort: SIP_PORT,
    rtpPortStart: RTP_PORT_START,
    codec: 'PCMU', // G.711 μ-law
  });

  // Handle incoming calls
  server.onCall(async (transport, callId) => {
    console.log(`Incoming call: ${callId}`);
    console.log(`RTP port: ${server.getRtpPort(callId)}`);

    try {
      // Create voice session
      const voiceSession = new KuralleVoiceSession({
        runtime: runtime,
        stt: new GeminiLiveSTT(),
        tts: new GeminiLiveTTS(),
        greeting: 'Hello! Thank you for calling customer support. How can I help you today?',
      });

      // Start the session
      const session = await server.startSession(callId, voiceSession);

      console.log(`Session started for call ${callId}`);

      // Handle when caller hangs up
      session.on(voice.AgentSessionEventTypes.Close, () => {
        console.log(`Call ${callId} ended`);
      });

    } catch (error) {
      console.error(`Error handling call ${callId}:`, error);
    }
  });

  // Start SIP server
  await server.listen();

  console.log(`SIP Customer Support Server running`);
  console.log(``);
  console.log(`Test with a SIP softphone:`);
  console.log(`  - Address: ${LOCAL_ADDRESS}:${SIP_PORT}`);
  console.log(`  - No authentication required`);
  console.log(`  - Send INVITE to start call`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
