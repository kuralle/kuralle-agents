/**
 * Customer Support Agent over 3CX PBX (SIP Trunking)
 *
 * This example shows a customer support agent accessible via 3CX PBX using SIP trunking.
 *
 * 3CX Setup:
 *   1. 3CX Management Console → Voice & Chat → + Add Trunk
 *   2. Select "Generic SIP Trunk (IP Based)"
 *   3. Enter your server details:
 *      - IP Address/Hostname: your-server-ip (or 0.0.0.0 for all interfaces)
 *      - Port: 5060
 *      - Transport: UDP
 *   4. Create Inbound Rules to route DIDs to this trunk
 *
 * Usage:
 *   bun run 3cx-support
 *
 * Environment Variables (optional):
 *   SERVER_IP: IP address to bind to (default: 0.0.0.0)
 *   SIP_PORT: SIP port to listen on (default: 5060)
 *   RTP_PORT_START: Start of RTP port range (default: 10000)
 *
 * Testing:
 *   - Configure 3CX SIP trunk to point to this server
 *   - Call your 3CX DID
 *   - Should route to Kuralle agent
 *
 * For local testing with a SIP softphone:
 *   - Address: 127.0.0.1:5060
 *   - Transport: UDP
 *   - Send INVITE to start call
 */

import { SIPAgentServer } from '@kuralle-agents/livekit-plugin-transport-sip';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger, voice } from '@livekit/agents';
import { buildSupportRuntime, supportGreeting } from '../support-agent/index.js';

// Configuration
const SERVER_IP = process.env.SERVER_IP || '0.0.0.0';
const SIP_PORT = parseInt(process.env.SIP_PORT || '5060', 10);
const RTP_PORT_START = parseInt(process.env.RTP_PORT_START || '10000', 10);
initializeLogger({ pretty: true });

// Codec: G.711 μ-law (PCMU) is the standard for 3CX and most PBX systems
const CODEC = 'PCMU'; // G.711 μ-law at 8kHz

const runtime = buildSupportRuntime(openai('gpt-4o-mini'));

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           3CX Customer Support Agent (SIP Trunking)          ║
╠══════════════════════════════════════════════════════════════╣
║  Status: ✅ Starting                                         ║
║  SIP Port: ${SIP_PORT.toString().padEnd(50)} ║
║  RTP Range: ${RTP_PORT_START}+                                ║
║  Codec: G.711 μ-law (8kHz)                                   ║
║  Bind Address: ${SERVER_IP.padEnd(45)} ║
╠══════════════════════════════════════════════════════════════╣
║  3CX Configuration:                                          ║
║  1. Add Trunk → "Generic SIP Trunk (IP Based)"              ║
║  2. IP: ${SERVER_IP === '0.0.0.0' ? 'your-server-ip' : SERVER_IP}                               ║
║  3. Port: ${SIP_PORT}                                             ║
║  4. Create Inbound Rule to route DIDs to this trunk          ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Create SIP server
  const server = new SIPAgentServer({
    localAddress: SERVER_IP,
    sipPort: SIP_PORT,
    rtpPortStart: RTP_PORT_START,
    codec: CODEC,
  });

  // Handle incoming calls from 3CX
  server.onCall(async (transport, callId) => {
    console.log(`\n📞 [3CX] Incoming call: ${callId}`);
    console.log(`   RTP port: ${server.getRtpPort(callId)}`);

    try {
      // Create voice session
      const voiceSession = new KuralleVoiceSession({
        runtime: runtime,
        stt: new GeminiLiveSTT(),
        tts: new GeminiLiveTTS(),
        greeting: 'Hello! Thank you for calling. How can I help you today?',
      });

      // Start the session
      const session = await server.startSession(callId, voiceSession);

      console.log(`✅ [3CX] Session started for call ${callId}`);

      // Handle when caller hangs up
      session.on(voice.AgentSessionEventTypes.Close, () => {
        console.log(`📴 [3CX] Call ${callId} ended`);
      });

    } catch (error) {
      console.error(`❌ [3CX] Error handling call ${callId}:`, error);
    }
  });

  // Start SIP server
  await server.listen();

  console.log(`\n✅ 3CX Customer Support Server running`);
  console.log(``);
  console.log(`🔧 Configuration for 3CX:`);
  console.log(`   Trunk Type: Generic SIP Trunk (IP Based)`);
  console.log(`   IP Address: ${SERVER_IP === '0.0.0.0' ? '<your-server-ip>' : SERVER_IP}`);
  console.log(`   Port: ${SIP_PORT}`);
  console.log(`   Transport: UDP`);
  console.log(``);
  console.log(`🧪 Testing Options:`);
  console.log(`   1. Configure 3CX SIP trunk and call your DID`);
  console.log(`   2. Use SIP softphone: ${SERVER_IP === '0.0.0.0' ? '127.0.0.1' : SERVER_IP}:${SIP_PORT}`);
  console.log(``);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
