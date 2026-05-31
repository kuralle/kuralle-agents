/**
 * Customer Support Agent over Twilio Media Streams
 *
 * This example shows a customer support agent accessible via phone call
 * through Twilio's Media Streams API.
 *
 * Usage:
 *   bun run twilio-support
 *
 * Configure your TwiML bin:
 *   <Response>
 *     <Connect>
 *       <Stream url="wss://your-domain.com/twilio/media" />
 *     </Connect>
 *   </Response>
 */

import { TwilioAgentServer } from '@kuralle-agents/livekit-plugin-transport-twilio';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger } from '@livekit/agents';

import { buildSupportRuntime, supportGreeting } from '../support-agent/index.js';

const PORT = 3000;
initializeLogger({ pretty: true });

const model = openai('gpt-4o-mini');
const runtime = buildSupportRuntime(model);

// Create Twilio server
const server = new TwilioAgentServer({ port: PORT });

// Handle incoming calls
server.onCall(async (callId, transport) => {
  console.log(`[${callId}] Incoming call from Twilio`);

  // Create voice session
  const voiceSession = new KuralleVoiceSession({
    runtime: runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello! Thank you for calling customer support. How can I help you today?',
  });

  // Start the session
  await server.startSession(callId, voiceSession);

  console.log(`[${callId}] Session started`);
});

// Start server
server.listen().then(() => {
  console.log(`Customer Support Server (Twilio) listening on port ${PORT}`);
  console.log(`Twilio Media Streams URL: wss://your-domain.com/twilio/media`);
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
