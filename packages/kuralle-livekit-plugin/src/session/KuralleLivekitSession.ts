import { getJobContext, type JobContext, voice } from '@livekit/agents';
import type { VAD } from '@livekit/agents';
import type { stt, tts } from '@livekit/agents';
import type { HarnessConfig, Runtime } from '@kuralle-agents/core';
import { createKuralleVoicePipeline } from './createKuralleVoicePipeline.js';
import { RecordingManager } from '../recording/manager.js';
import type { RecordingStorageAdapter } from '../recording/storage.js';
import type { KuralleRuntimeLLMAdapter } from '../llm/KuralleRuntimeLLMAdapter.js';
import type { VoiceMetricsSink } from '../metrics/types.js';
import { attachMetricsBridge } from '../metrics/bridge.js';
import { mergeVoiceOptions } from './voice_defaults.js';

export interface KuralleLivekitSessionOptions {
  runtime: Runtime | HarnessConfig;
  stt: stt.STT;
  tts: tts.TTS;
  vad?: VAD;
  turnDetection?: voice.AgentSessionOptions['turnDetection'];
  voiceOptions?: Partial<voice.VoiceOptions>;
  /**
   * Greeting spoken when the session starts.
   * - string: speak this text
   * - undefined (omitted): speak the default greeting
   * - null: no greeting
   */
  greeting?: string | null;
  prompt?: string;
  onKuralleHandoff?: (from: string, to: string) => void | Promise<void>;
  /**
   * Callback for voice pipeline metrics. Called synchronously, fire-and-forget.
   *
   * Receives both LiveKit-originated metrics (STT, TTS, LLM, VAD, EOU)
   * and Kuralle-originated metrics (Runtime TTFT, Runtime duration).
   *
   * If not provided, metrics are silently discarded.
   */
  onMetrics?: VoiceMetricsSink;
  recording?: {
    adapter: RecordingStorageAdapter;
    tags?: Record<string, string>;
    ctx?: JobContext;
  };
}

export interface KuralleSession {
  start(args: { room: NonNullable<Parameters<voice.AgentSession['start']>[0]['room']> }): Promise<void>;
  stop(): Promise<void>;
  readonly session: voice.AgentSession;
  readonly ariaLLM: KuralleRuntimeLLMAdapter;
}

interface GeminiFillerSource {
  onFiller(listener: (payload: { filler: string; transcript: string; requestId: string }) => void): () => void;
}

function isGeminiFillerSource(value: unknown): value is GeminiFillerSource {
  return typeof (value as GeminiFillerSource | undefined)?.onFiller === 'function';
}

export function KuralleLivekitSession(opts: KuralleLivekitSessionOptions): KuralleSession {
  const pipeline = createKuralleVoicePipeline({
    ...opts,
    onMetrics: opts.onMetrics,
  });

  const session = new voice.AgentSession({
    stt: opts.stt,
    tts: opts.tts,
    vad: opts.vad,
    llm: pipeline.ariaLLM,
    turnDetection: opts.turnDetection,
    voiceOptions: mergeVoiceOptions(opts.voiceOptions),
  });

  let detachMetrics: (() => void) | undefined;

  let detachFiller: (() => void) | undefined;
  if (isGeminiFillerSource(opts.stt)) {
    detachFiller = opts.stt.onFiller((payload) => {
      void pipeline.fillerCoordinator.speakFiller(session, payload.filler);
    });
  }

  let recordingManager: RecordingManager | undefined;
  if (opts.recording) {
    const context = opts.recording.ctx ?? (() => {
      try {
        return getJobContext();
      } catch {
        return undefined;
      }
    })();

    if (!context) {
      throw new Error(
        'KuralleLivekitSession: recording requires a LiveKit JobContext. Pass recording.ctx explicitly or run inside a LiveKit job.',
      );
    }

    recordingManager = new RecordingManager({
      adapter: opts.recording.adapter,
      session,
      ctx: context,
      tags: opts.recording.tags,
    });
    recordingManager.attach();
  }

  return {
    session,
    ariaLLM: pipeline.ariaLLM,
    async start({ room }) {
      const roomName = room.name || 'unknown-room';
      pipeline.ariaLLM.setSessionContext({
        sessionId: `livekit:${roomName}:${crypto.randomUUID()}`,
      });
      await session.start({
        agent: pipeline.agent,
        room,
        record: Boolean(recordingManager),
      });

      // Wire metrics bridge: LiveKit AgentSession -> VoiceMetricsSink callback
      if (opts.onMetrics) {
        detachMetrics = attachMetricsBridge(
          session,
          `livekit:${roomName}:${pipeline.ariaLLM.model}`,
          opts.onMetrics,
        );
      }

      // Greeting: null = no greeting, undefined = default, string = custom
      if (opts.greeting !== null) {
        const greeting = opts.greeting ?? "Hello! I'm your AI assistant. How can I help?";
        await session.say(greeting, {
          allowInterruptions: true,
          addToChatCtx: false,
        });
      }
    },
    async stop() {
      detachMetrics?.();
      detachMetrics = undefined;
      detachFiller?.();
      detachFiller = undefined;
      await session.close();
    },
  };
}
