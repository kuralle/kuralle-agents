/**
 * Twilio Voice Agent - Simple example showing how to receive Twilio calls
 *
 * This example shows how to run an Kuralle voice agent that receives calls from Twilio.
 *
 * Usage:
 *   bun run build
 *   npx tsx examples/voice_agent.ts
 *
 * Twilio Setup:
 * 1. Create a TwiML Application in your Twilio console
 * 2. Set the Voice URL to point to this server:
 *    wss://your-domain.com/twilio/media
 * 3. Or use ngrok for local testing:
 *    ngrok http 8080
 * 4. Configure your Twilio number to use the TwiML App
 */
import { TwilioAgentServer } from '../src/index.js';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger } from '@livekit/agents';

const PORT = parseInt(process.env.PORT || '8080');
const HOST = process.env.HOST || '0.0.0.0';

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
  console.log('Starting Twilio Voice Agent Server');
  console.log(`Listening on ws://${HOST}:${PORT}`);
  console.log('');

  // Create Twilio server
  const server = new TwilioAgentServer({
    port: PORT,
    host: HOST,
  });

  // Handle incoming calls
  server.onCall(async (callId, transport) => {
    console.log(`[Call ${callId}] Incoming call from Twilio`);

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

  // Start Twilio server
  await server.listen();

  console.log('');
  console.log('Twilio Voice Agent Server running');
  console.log('');
  console.log('Twilio Setup:');
  console.log(`  1. Create a TwiML Application in Twilio console`);
  console.log(`  2. Set Voice URL to: wss://your-domain.com/twilio/media`);
  console.log(`  3. Configure your Twilio number to use the TwiML App`);
  console.log('');
  console.log('For local testing, use ngrok:');
  console.log(`  ngrok http ${PORT}`);
  console.log('');
  console.log('Agent will greet you and respond to what you say!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
