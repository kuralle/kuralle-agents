import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  metrics,
  voice,
} from '@livekit/agents';
import { KuralleRuntimeLLMAdapter } from '@kuralle-agents/livekit-plugin';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent';
import { createBotRuntime } from './runtime';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx: JobContext) => {
    // The Kuralle runtime is the LLM: it owns the agent's instructions,
    // tools, flows, and routing. The LiveKit session wraps it with STT/TTS,
    // turn detection, and the room connection.
    const session = new voice.AgentSession({
      // Speech-to-text — see https://docs.livekit.io/agents/models/stt/
      stt: new inference.STT({
        model: 'deepgram/nova-3',
        language: 'multi',
      }),

      // The brain: a Kuralle runtime, adapted to LiveKit's LLM interface.
      llm: new KuralleRuntimeLLMAdapter({ runtime: createBotRuntime() }),

      // Text-to-speech — see https://docs.livekit.io/agents/models/tts/
      tts: new inference.TTS({
        model: 'cartesia/sonic-3',
        voice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
      }),

      // VAD + turn detection decide when the user is done speaking.
      // See https://docs.livekit.io/agents/build/turns
      turnDetection: new livekit.turnDetector.MultilingualModel(),
      vad: ctx.proc.userData.vad! as silero.VAD,
      voiceOptions: {
        // Preemptive replies run the LLM before end-of-turn. Off by default
        // because the Kuralle runtime executes a full turn per call.
        preemptiveGeneration: false,
      },
    });

    // Metrics + usage logging — https://docs.livekit.io/agents/build/metrics/
    const usageCollector = new metrics.UsageCollector();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      usageCollector.collect(ev.metrics);
    });
    ctx.addShutdownCallback(async () => {
      console.log(`Usage: ${JSON.stringify(usageCollector.getSummary())}`);
    });

    // Start the session, then join the room and connect to the user.
    await session.start({
      agent: new Agent(),
      room: ctx.room,
      inputOptions: {
        // LiveKit Cloud enhanced noise cancellation. Omit if self-hosting.
        noiseCancellation: BackgroundVoiceCancellation(),
      },
    });

    await ctx.connect();

    // Greet the user on joining.
    session.generateReply({
      instructions: 'Greet the user in a helpful and friendly manner.',
    });
  },
});

// Run the agent worker. `node dist/main.js dev` connects it to LiveKit locally.
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);
