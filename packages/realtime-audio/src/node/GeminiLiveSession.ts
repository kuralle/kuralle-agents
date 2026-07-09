import { GoogleGenAI } from '@google/genai';
import type { GeminiConfig, VoiceAgentConfig, RealtimeEvent } from '../types.js';
import type { FunctionDeclaration as GeminiFunctionDeclaration } from '@kuralle-agents/voice-protocol/schema';
import { toolSetToJsonSchema } from '@kuralle-agents/voice-protocol/schema';
import type {
  RealtimeAudioClient,
  RealtimeCapabilities,
  RealtimeSessionConfig,
  RealtimeToolResponse,
  RealtimeEventMap,
} from '@kuralle-agents/core/realtime';
import { GEMINI_CAPABILITIES } from '../gemini/common.js';
import { debug } from '../debug.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-live-preview';
const SAMPLE_RATE = 24000;

type GeminiLiveSessionHandle = Awaited<
  ReturnType<InstanceType<typeof GoogleGenAI>['live']['connect']>
>;

interface GeminiServerMessage {
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: { data?: string }; text?: string }> };
    outputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> };
  sessionResumptionUpdate?: { newHandle?: string };
}

function isGeminiServerMessage(value: unknown): value is GeminiServerMessage {
  return typeof value === 'object' && value !== null;
}

export interface GeminiLiveSessionConfig {
  gemini: GeminiConfig;
  agent: VoiceAgentConfig;
  onEvent: (event: RealtimeEvent) => void;
  /**
   * Optional overrides applied during connect(). When set, these take
   * precedence over values derived from the agent config. Used by capability-
   * aware orchestration to inject prompts and tools on connect.
   */
  overrides?: {
    systemInstruction?: string;
    tools?: GeminiFunctionDeclaration[];
  };
}

/**
 * Thin wrapper around @google/genai ai.live.connect().
 *
 * Manages:
 * - Connection lifecycle (connect/disconnect)
 * - Audio input/output encoding (base64 PCM ↔ Uint8Array)
 * - Tool call dispatch → onEvent callback
 * - Session resumption via newHandle
 */
export class GeminiLiveSession implements RealtimeAudioClient {
  private ai: InstanceType<typeof GoogleGenAI>;
  private session: GeminiLiveSessionHandle | null = null;
  private config: GeminiLiveSessionConfig;
  private resumptionHandle?: string;
  private _connected = false;
  /**
   * Incremented on each connect(). Callbacks capture the generation at registration
   * time so a late onclose/onerror/onmessage from a replaced Live socket cannot
   * clear `_connected` or emit `disconnected` after updateConfig() reconnect.
   */
  private liveConnectionGeneration = 0;
  /** True during updateConfig() reconnect cycle — suppresses 'disconnected' event. */
  private _reconfiguring = false;
  /**
   * Set for the duration of updateConfig() until the *new* connection's onopen
   * (see `_expectedReconfigureGeneration`). Avoids treating SDK onclose that
   * arrives before onopen as a user-visible disconnect.
   */
  private _awaitingReconfigureOpen = false;
  /** Generation assigned in connect() while awaiting reconfigure — matches only the new socket. */
  private _expectedReconfigureGeneration: number | null = null;
  /**
   * After a flow reconfigure, the Live SDK sometimes delivers quick spurious onclose
   * events on the new socket. Bounded silent `connect()` retries (same overrides)
   * restore audio without tearing down the WS transport.
   */
  private _postReconfigureQuietDeadline = 0;
  private _postReconfigureAutoReconnectsLeft = 0;
  /** Mutable overrides updated by updateConfig(). Merged with config.overrides. */
  private runtimeOverrides?: { systemInstruction?: string; tools?: GeminiFunctionDeclaration[] };
  /** Typed event listener registry for the RealtimeAudioClient interface. */
  private listeners: Map<keyof RealtimeEventMap, Set<(...args: unknown[]) => void>> = new Map();

  // ─── RealtimeAudioClient v2 — capabilities / provider / model ──────────────

  readonly capabilities: RealtimeCapabilities = GEMINI_CAPABILITIES;
  readonly provider: string = 'gemini';
  readonly model: string;

  constructor(config: GeminiLiveSessionConfig) {
    this.config = config;
    this.ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    this.model = config.gemini.model ?? DEFAULT_MODEL;
  }

  get connected(): boolean {
    return this._connected;
  }

  // ─── RealtimeAudioClient: on / off / ping ───────────────────────────────────

  on<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as (...args: unknown[]) => void);
  }

  off<K extends keyof RealtimeEventMap>(event: K, handler: RealtimeEventMap[K]): void {
    this.listeners.get(event)?.delete(handler as (...args: unknown[]) => void);
  }

  private emitEvent<K extends keyof RealtimeEventMap>(
    event: K,
    ...args: Parameters<RealtimeEventMap[K]>
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(...(args as unknown[]));
    }
  }

  /**
   * Gemini Live wraps the underlying WebSocket via @google/genai SDK.
   * There is no direct ping API, so we return connection state as a health check.
   */
  async ping(): Promise<boolean> {
    return Promise.resolve(this._connected);
  }

  /**
   * Connect to Gemini Live.
   *
   * @param config Optional RealtimeSessionConfig. When provided, systemInstruction
   *   and tools are applied as runtimeOverrides (takes precedence over constructor
   *   config.overrides and agent config). The argumentless form remains supported
   *   for callers that already pinned overrides via the constructor.
   */
  async connect(config?: RealtimeSessionConfig): Promise<void> {
    // If a RealtimeSessionConfig is provided (RealtimeAudioClient interface call),
    // store its fields as runtimeOverrides so they win over constructor config.
    if (config) {
      this.runtimeOverrides = {
        systemInstruction: config.systemInstruction,
        tools: config.tools,
      };
    }

    const { agent, gemini } = this.config;
    const model = (config?.model ?? gemini.model) ?? DEFAULT_MODEL;

    // Merge overrides: runtimeOverrides (from updateConfig) take priority over
    // config.overrides (from constructor), which take priority over agent config.
    const activeOverrides = { ...this.config.overrides, ...this.runtimeOverrides };

    // Gemini 3.1 rejects empty tools arrays — only send when declarations exist.
    const declarations = activeOverrides.tools
      ?? (agent.tools ? toolSetToJsonSchema(agent.tools, 'gemini') : undefined);
    const tools = declarations && declarations.length > 0
      ? [{ functionDeclarations: declarations }]
      : undefined;

    // Resolve prompt — active overrides win, then fall back to agent config.
    const promptText = activeOverrides.systemInstruction ?? (() => {
      const agentPrompt = agent.prompt;
      if (!agentPrompt) return '';
      if (typeof agentPrompt === 'string') return agentPrompt;
      // PromptTemplate / AgentPrompt: join sections
      return (agentPrompt as { sections: Array<{ content: string }> }).sections
        .map(s => s.content)
        .join('\n\n');
    })();

    const liveConfig: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      systemInstruction: { parts: [{ text: promptText }] },
      tools,
      outputAudioTranscription: {},
    };

    if (agent.voice) {
      liveConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: agent.voice } },
      };
    }

    if (this.resumptionHandle) {
      liveConfig.sessionResumption = { handle: this.resumptionHandle };
    }

    debug('[GeminiLiveSession] Connecting with config:', {
      model,
      promptLength: promptText.length,
      toolCount: tools?.length ?? 0,
      toolNames:
        tools?.[0]?.functionDeclarations?.map((d: { name?: string }) => d.name ?? '') ?? [],
      voice: agent.voice,
      hasResumption: !!this.resumptionHandle,
    });

    const connectionGeneration = ++this.liveConnectionGeneration;
    if (this._awaitingReconfigureOpen) {
      this._expectedReconfigureGeneration = connectionGeneration;
    }

    this.session = await this.ai.live.connect({
      model,
      config: liveConfig,
      callbacks: {
        onopen: () => {
          if (connectionGeneration !== this.liveConnectionGeneration) return;
          this._connected = true;
          if (
            this._awaitingReconfigureOpen &&
            this._expectedReconfigureGeneration === connectionGeneration
          ) {
            this._awaitingReconfigureOpen = false;
            this._expectedReconfigureGeneration = null;
            this._reconfiguring = false;
            this._postReconfigureQuietDeadline = Date.now() + 8000;
            // The Live socket occasionally delivers two quick closes after a reconnect;
            // one retry is not always enough across multiple flow transitions.
            this._postReconfigureAutoReconnectsLeft = 2;
          }
          // Do not clear _postReconfigure* in an else branch — the SDK may call
          // onopen more than once; clearing would drop the post-reconnect retry budget.
          debug('[GeminiLiveSession] Connection opened');
        },
        onmessage: (message: unknown) => {
          if (connectionGeneration !== this.liveConnectionGeneration) return;
          this.handleServerMessage(message);
        },
        onerror: (error: unknown) => {
          if (connectionGeneration !== this.liveConnectionGeneration) return;
          const errMsg = String(error);
          this.config.onEvent({ type: 'error', error: errMsg });
          this.emitEvent('error', errMsg);
        },
        onclose: () => {
          if (connectionGeneration !== this.liveConnectionGeneration) return;
          this._connected = false;
          debug(`[GeminiLiveSession] Connection closed (reconfiguring=${this._reconfiguring})`);

          if (this._reconfiguring) {
            return;
          }

          const reopenFailed =
            this._awaitingReconfigureOpen &&
            this._expectedReconfigureGeneration === connectionGeneration;

          if (reopenFailed) {
            this._awaitingReconfigureOpen = false;
            this._expectedReconfigureGeneration = null;
            this._reconfiguring = false;
            this.emitEvent('disconnected');
            return;
          }

          if (
            this._postReconfigureAutoReconnectsLeft > 0 &&
            Date.now() < this._postReconfigureQuietDeadline
          ) {
            this._postReconfigureAutoReconnectsLeft--;
            console.warn('[GeminiLiveSession] Transient close after reconfigure — reconnecting once');
            void this.connect().catch(() => {
              this._postReconfigureQuietDeadline = 0;
              this._postReconfigureAutoReconnectsLeft = 0;
              this.emitEvent('disconnected');
            });
            return;
          }

          this._postReconfigureQuietDeadline = 0;
          this._postReconfigureAutoReconnectsLeft = 0;
          this.emitEvent('disconnected');
        },
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.session) {
      try {
        await this.session.close();
      } catch {
        // Ignore close errors
      }
      this._connected = false;
      this.session = null;
    }
    if (!this._reconfiguring) {
      this._postReconfigureQuietDeadline = 0;
      this._postReconfigureAutoReconnectsLeft = 0;
    }
  }

  /**
   * Send a raw PCM audio frame to Gemini Live.
   * Input: Uint8Array of 16-bit PCM samples at 24kHz.
   */
  sendAudio(frame: Uint8Array): void {
    if (!this.session || !this._connected) return;

    const base64 = Buffer.from(frame).toString('base64');
    this.session.sendRealtimeInput({
      audio: {
        data: base64,
        mimeType: `audio/pcm;rate=${SAMPLE_RATE}`,
      },
    });
  }

  /**
   * Send a tool response back to Gemini Live.
   */
  sendToolResponse(responses: RealtimeToolResponse[]): void {
    if (!this.session) return;

    this.session.sendToolResponse({
      functionResponses: responses.map(r => ({
        id: r.id,
        name: r.name,
        response: { output: r.output },
      })),
    });
  }

  /**
   * Update the session config (system prompt and/or tools) by disconnecting
   * and reconnecting with the new overrides. The existing resumption handle is
   * preserved so the conversation context is not lost.
   *
   * Accepts Partial<RealtimeSessionConfig> to satisfy the RealtimeAudioClient
   * interface. Only systemInstruction and tools fields are applied; other fields
   * (voice, model, audio) require a full reconnect via connect().
   */
  async updateConfig(config: Partial<RealtimeSessionConfig>): Promise<void> {
    this.runtimeOverrides = {
      systemInstruction: config.systemInstruction,
      tools: config.tools,
    };
    // Set reconfiguring flag to suppress the 'disconnected' event during
    // the reconnect cycle. Without this, VoiceCallSession would interpret the
    // disconnect as a connection loss and terminate the session.
    this._reconfiguring = true;
    this._awaitingReconfigureOpen = true;
    try {
      await this.disconnect();
      await this.connect();
    } catch (err) {
      this._awaitingReconfigureOpen = false;
      this._expectedReconfigureGeneration = null;
      this._reconfiguring = false;
      this._postReconfigureQuietDeadline = 0;
      this._postReconfigureAutoReconnectsLeft = 0;
      throw err;
    }
    // Do not clear _reconfiguring here: ai.live.connect may resolve before
    // onopen. Matching onopen / failed-reopen onclose clears flags.
  }

  /**
   * Nudge the model to speak after reconfigure. Tries sendClientContent first;
   * falls back to sendRealtimeInput with text for models that restrict client content.
   */
  requestResponse(instruction?: string): void {
    if (!this.session || !this._connected) return;
    const text = instruction ?? 'Continue from the current flow state now.';
    try {
      if (typeof this.session.sendClientContent === 'function') {
        this.session.sendClientContent({
          turns: [{ role: 'user', parts: [{ text }] }],
        });
        return;
      }
    } catch (err) {
      console.error('[GeminiLiveSession] sendClientContent failed, falling back to sendRealtimeInput:', err);
    }
    try {
      this.session.sendRealtimeInput({ text });
    } catch (err) {
      console.error('[GeminiLiveSession] requestResponse failed:', err);
    }
  }

  // --- Private ---

  private handleServerMessage(message: unknown): void {
    if (!isGeminiServerMessage(message)) return;

    // Audio output
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          const audioData = new Uint8Array(Buffer.from(part.inlineData.data, 'base64'));
          this.config.onEvent({ type: 'audio', data: audioData });
          this.emitEvent('audio', audioData);
        }
        if (part.text) {
          this.config.onEvent({ type: 'transcript', text: part.text, role: 'assistant' });
          this.emitEvent('transcript', part.text, 'assistant');
        }
      }
    }

    // Output audio transcription
    if (message.serverContent?.outputTranscription?.text) {
      const text: string = message.serverContent.outputTranscription.text;
      this.config.onEvent({ type: 'transcript', text, role: 'assistant' });
      this.emitEvent('transcript', text, 'assistant');
    }

    // Input transcription
    if (message.serverContent?.inputTranscription?.text) {
      const text: string = message.serverContent.inputTranscription.text;
      this.config.onEvent({ type: 'transcript', text, role: 'user' });
      this.emitEvent('transcript', text, 'user');
    }

    // Turn complete
    if (message.serverContent?.turnComplete) {
      this.config.onEvent({ type: 'turn-complete' });
      this.emitEvent('turn-complete');
    }

    // Interrupted
    if (message.serverContent?.interrupted) {
      this.config.onEvent({ type: 'interrupted' });
      this.emitEvent('interrupted');
    }

    // Tool calls
    if (message.toolCall?.functionCalls) {
      for (const fc of message.toolCall.functionCalls) {
        if (!fc.id || !fc.name) continue;
        this.config.onEvent({ type: 'tool-call', id: fc.id, name: fc.name, args: fc.args });
        this.emitEvent('tool-call', fc.id, fc.name, fc.args);
      }
    }

    // Session resumption — internal only, no RealtimeEventMap equivalent
    if (message.sessionResumptionUpdate?.newHandle) {
      this.resumptionHandle = message.sessionResumptionUpdate.newHandle;
      this.config.onEvent({
        type: 'session-resumed',
        newHandle: this.resumptionHandle!,
      });
    }
  }
}
