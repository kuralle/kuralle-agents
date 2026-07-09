import { AudioFrame } from '@livekit/rtc-node';
import { llm } from '@livekit/agents';
import type { NativeAudioTransport } from '../native_audio_transport.js';

/** Duck-typed realtime session for Path B (matches transport-ws wire types). */
export type LiveKitSessionRunnerSession = {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  chatCtx: llm.ChatContext;
  tools?: llm.ToolContext;
  pushAudio(frame: AudioFrame): void;
  updateChatCtx(chatCtx: llm.ChatContext): Promise<void>;
  close(): Promise<void>;
};

export type LiveKitSessionRunnerAdapter = {
  attach(session: LiveKitSessionRunnerSession): Promise<void>;
  detach(): Promise<void>;
  onTurnComplete(): Promise<void>;
};

export interface LiveKitSessionRunnerConfig {
  session: LiveKitSessionRunnerSession;
  adapter: LiveKitSessionRunnerAdapter;
  transport: NativeAudioTransport;
  sessionId?: string;
  sampleRate?: number;
  numChannels?: number;
  onToolResult?: (
    toolName: string,
    args: unknown,
    result: unknown,
    success: boolean,
  ) => void;
  /** Fired after {@link LiveKitSessionRunnerAdapter.onTurnComplete} resolves. */
  onTurnComplete?: () => void;
  /** Fired if {@link LiveKitSessionRunnerAdapter.onTurnComplete} rejects. */
  onTurnCompleteError?: () => void;
  onUserTranscript?: (text: string) => void;
  onSessionEnd?: (reason: string) => void;
}

/**
 * Transport-agnostic plumbing for LiveKit native audio sessions: tool execution,
 * adapter lifecycle hooks, and PCM ↔ {@link AudioFrame} bridging.
 */
export class LiveKitSessionRunner {
  readonly sessionId: string;
  #config: LiveKitSessionRunnerConfig;
  #sampleRate: number;
  #numChannels: number;
  #running = false;
  #stopped = false;

  constructor(config: LiveKitSessionRunnerConfig) {
    this.#config = config;
    this.sessionId = config.sessionId ?? `bridge-${Date.now()}`;
    this.#sampleRate = config.sampleRate ?? 24000;
    this.#numChannels = config.numChannels ?? 1;
  }

  get running(): boolean {
    return this.#running;
  }

  async start(): Promise<void> {
    if (this.#running || this.#stopped) {
      throw new Error('LiveKitSessionRunner: already started or stopped');
    }

    const { session, adapter, transport } = this.#config;

    session.on('generation_created', (...args: unknown[]) => {
      const event = args[0] as llm.GenerationCreatedEvent;
      const messageReader = event.messageStream.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value: message } = await messageReader.read();
            if (done) break;

            const audioReader = message.audioStream.getReader();
            void (async () => {
              try {
                while (true) {
                  const { done: audioDone, value: frame } = await audioReader.read();
                  if (audioDone) break;
                  const f = frame.data;
                  try {
                    transport.sendAudio(
                      new Uint8Array(f.buffer, f.byteOffset, f.byteLength),
                    );
                  } catch {
                    /* ignore */
                  }
                }
              } catch {
                /* ignore */
              }
            })();

            const textReader = message.textStream.getReader();
            void (async () => {
              try {
                while (true) {
                  const { done: textDone } = await textReader.read();
                  if (textDone) break;
                }
              } catch {
                /* ignore */
              }
            })();
          }
        } catch {
          /* ignore */
        }
      })();

      const functionReader = event.functionStream.getReader();
      void (async () => {
        try {
          while (true) {
            const { done, value: fnCall } = await functionReader.read();
            if (done) break;
            await this.#executeFunctionCall(fnCall);
          }
        } catch {
          /* ignore */
        }
      })();
    });

    session.on('turn_complete', () => {
      void adapter
        .onTurnComplete()
        .then(() => {
          this.#config.onTurnComplete?.();
        })
        .catch(() => {
          this.#config.onTurnCompleteError?.();
        });
    });

    session.on('input_audio_transcription_completed', (...args: unknown[]) => {
      const evt = args[0] as llm.InputTranscriptionCompleted;
      if (evt.isFinal && evt.transcript?.trim()) {
        this.#config.onUserTranscript?.(evt.transcript);
      }
    });

    transport.onAudio((data: Uint8Array) => {
      if (this.#stopped) return;
      const n = Math.floor(data.byteLength / 2);
      if (n <= 0) return;
      const int16 = new Int16Array(n);
      for (let i = 0; i < n; i++) {
        int16[i] = data[i * 2]! | (data[i * 2 + 1]! << 8);
      }
      try {
        session.pushAudio(new AudioFrame(int16, this.#sampleRate, this.#numChannels, n));
      } catch {
        /* ignore */
      }
    });

    transport.onClose(() => {
      void this.stop('transport_close');
    });

    try {
      await adapter.attach(session);
    } catch (err) {
      this.#stopped = true;
      await adapter.detach().catch(() => {});
      await session.close().catch(() => {});
      this.#config.onSessionEnd?.('attach_failed');
      try {
        transport.close();
      } catch {
        /* ignore */
      }
      throw err;
    }

    this.#running = true;
  }

  async stop(reason: string = 'external_stop'): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#running = false;

    const { adapter, session, transport } = this.#config;
    await adapter.detach().catch(() => {});
    await session.close().catch(() => {});
    try {
      transport.close();
    } catch {
      /* ignore */
    }
    this.#config.onSessionEnd?.(reason);
  }

  async #executeFunctionCall(fnCall: llm.FunctionCall): Promise<void> {
    const { session } = this.#config;
    const toolDef = session.tools?.[fnCall.name];
    if (!toolDef || typeof toolDef.execute !== 'function') {
      return;
    }

    let args: unknown = fnCall.args ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}');
      } catch {
        args = {};
      }
    }

    let output: unknown;
    let isError = false;
    try {
      output = await toolDef.execute(args, llm.createToolOptions(fnCall.callId));
    } catch (err) {
      isError = true;
      output = { error: err instanceof Error ? err.message : String(err) };
    }

    const chatCtx = session.chatCtx.copy();
    chatCtx.insert(
      new llm.FunctionCallOutput({
        callId: fnCall.callId,
        name: fnCall.name,
        output: typeof output === 'string' ? output : JSON.stringify(output ?? {}),
        isError,
        createdAt: Date.now(),
      }),
    );
    await session.updateChatCtx(chatCtx);
    this.#config.onToolResult?.(fnCall.name, args, output, !isError);
  }
}
