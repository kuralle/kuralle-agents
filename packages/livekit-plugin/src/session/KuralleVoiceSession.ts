import { voice, stt, tts, type VAD } from '@livekit/agents';
import type { Runtime, HarnessConfig } from '@kuralle-agents/core';
import type { KuralleRuntimeLLMAdapter, KuralleRuntimeLike } from '../llm/KuralleRuntimeLLMAdapter.js';
import type { FillerCoordinator } from '../filler/FillerCoordinator.js';
import type { TransportAdapter } from '../transport_adapter.js';
import type { VoiceMetricsSink } from '../metrics/types.js';
import { attachMetricsBridge } from '../metrics/bridge.js';
import { createKuralleVoicePipeline, type KuralleVoicePipeline } from './createKuralleVoicePipeline.js';
import { mergeVoiceOptions } from './voice_defaults.js';
import type { VoiceSession } from './VoiceSession.js';

type SampleRateConfigurableSTT = stt.STT & {
  updateOptions?: (opts: { sampleRate?: number }) => void;
};

export interface KuralleVoiceSessionOptions {
  runtime: Runtime | HarnessConfig | KuralleRuntimeLike;
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
}

/**
 * A voice session powered by Kuralle Runtime.
 *
 * Wraps the Aria Runtime with LiveKit's voice infrastructure,
 * providing speech-to-text, text-to-speech, and LLM capabilities.
 *
 * Used for transport-backed sessions (WebSocket, HTTP, Twilio, SIP).
 * For LiveKit room-backed sessions, use KuralleLivekitSession instead.
 */
export class KuralleVoiceSession implements VoiceSession {
  private readonly pipeline: KuralleVoicePipeline;
  private livekitSession: voice.AgentSession | null = null;
  private detachMetrics: (() => void) | null = null;
  #sessionId: string | null = null;

  readonly options: KuralleVoiceSessionOptions;

  /** @inheritdoc {@link VoiceSession.sessionId} */
  get sessionId(): string {
    if (!this.#sessionId) {
      throw new Error('KuralleVoiceSession: sessionId is only available after start()');
    }
    return this.#sessionId;
  }

  get ariaLLM(): KuralleRuntimeLLMAdapter { return this.pipeline.ariaLLM; }
  get agent(): voice.Agent { return this.pipeline.agent; }
  get fillerCoordinator(): FillerCoordinator { return this.pipeline.fillerCoordinator; }

  constructor(opts: KuralleVoiceSessionOptions) {
    this.options = opts;
    this.pipeline = createKuralleVoicePipeline({
      ...opts,
      onMetrics: opts.onMetrics,
    });
  }

  /**
   * Start the voice session with a transport adapter.
   *
   * Creates and starts a LiveKit AgentSession with the configured
   * STT, TTS, VAD, and LLM, wiring the transport's audio I/O.
   */
  async start(transport: TransportAdapter): Promise<voice.AgentSession> {
    if (this.livekitSession) {
      throw new Error('Session already started');
    }

    this.#sessionId = transport.id;
    this.pipeline.ariaLLM.setSessionContext({ sessionId: transport.id });

    const session = new voice.AgentSession({
      stt: this.options.stt,
      tts: this.options.tts,
      vad: this.options.vad,
      llm: this.pipeline.ariaLLM,
      turnDetection: this.options.turnDetection,
      voiceOptions: mergeVoiceOptions(this.options.voiceOptions),
    });

    session.input.audio = transport.audioInput;
    session.output.audio = transport.audioOutput;
    session.output.transcription = transport.textOutput;

    if (transport.config.sampleRate) {
      const configurableStt = this.options.stt as SampleRateConfigurableSTT;
      configurableStt.updateOptions?.({ sampleRate: transport.config.sampleRate });
    }

    try {
      await session.start({ agent: this.pipeline.agent });
    } catch (err) {
      try { await session.close(); } catch { /* swallow cleanup errors */ }
      throw err;
    }

    // Assign before greeting so close() can clean up if greeting fails
    this.livekitSession = session;

    // Wire metrics bridge: LiveKit AgentSession -> VoiceMetricsSink callback
    if (this.options.onMetrics) {
      this.detachMetrics = attachMetricsBridge(session, transport.id, this.options.onMetrics);
    }

    // Greeting: null = no greeting, undefined = default, string = custom
    if (this.options.greeting !== null) {
      const greeting = this.options.greeting ?? "Hello! I'm your AI assistant. How can I help?";
      await session.say(greeting, {
        allowInterruptions: true,
        addToChatCtx: false,
      });
    }

    return session;
  }

  async close(): Promise<void> {
    this.detachMetrics?.();
    this.detachMetrics = null;

    if (this.livekitSession) {
      await this.livekitSession.close();
      this.livekitSession = null;
    }
  }

  getSession(): voice.AgentSession | null {
    return this.livekitSession;
  }

  generateReply(options?: {
    userInput?: string;
    instructions?: string;
  }): ReturnType<voice.AgentSession['generateReply']> {
    if (!this.livekitSession) {
      throw new Error('Session not started');
    }
    return this.livekitSession.generateReply(options);
  }

  async say(
    text: string,
    options?: { allowInterruptions?: boolean; addToChatCtx?: boolean },
  ): Promise<void> {
    if (!this.livekitSession) {
      throw new Error('Session not started');
    }
    await this.livekitSession.say(text, options);
  }
}
