import {
  type APIConnectOptions,
  asLanguageCode,
  Future,
  log,
  shortuuid,
  stt,
  stream as lkStream,
} from '@livekit/agents';
import { GoogleGenAI, Modality } from '@google/genai';
import { buildFillerInstruction, parseFillerResponse } from './filler.js';
import { GeminiAudioFrameProcessor } from './audio_frame_processor.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 3000;
const RESUME_BUFFER_LIMIT = 320;
const DEFAULT_VOICE = 'Kore';

interface PCMFrame {
  data: Int16Array;
}

interface GeminiRealtimeBlob {
  data: string;
  mimeType: string;
}

export interface GeminiLiveSession {
  sendRealtimeInput(payload: {
    audio?: GeminiRealtimeBlob;
    media?: GeminiRealtimeBlob;
    audioStreamEnd?: boolean;
    text?: string;
  }): void;
  sendClientContent?(payload?: { turns?: unknown[]; turnComplete?: boolean }): void;
  close(): Promise<void> | void;
}

export interface GeminiLiveConnectCallbacks {
  onopen?: () => void;
  onmessage?: (message: unknown) => void;
  onerror?: (error: unknown) => void;
  onclose?: (event: unknown) => void;
}

export interface GeminiLiveClient {
  live: {
    connect(args: {
      model: string;
      config: Record<string, unknown>;
      callbacks: GeminiLiveConnectCallbacks;
    }): Promise<GeminiLiveSession>;
  };
  models?: {
    generateContentStream?: (args: unknown) => Promise<AsyncIterable<unknown>>;
  };
}

/**
 * Runtime validation that a value conforms to the GeminiLiveClient interface.
 *
 * GoogleGenAI from @google/genai exposes `.live.connect()` at runtime but its
 * TypeScript declarations do not include the `live` property. Instead of casting
 * via structural validation at construction (no unsafe cast at the call site).
 * time and return the narrowed type. If @google/genai changes its API surface,
 * this throws immediately with a descriptive message rather than failing later
 * on the first `.live.connect()` call.
 */
export function assertGeminiLiveClient(value: unknown, label: string): GeminiLiveClient {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('live' in value) ||
    typeof (value as Record<string, unknown>).live !== 'object' ||
    (value as Record<string, unknown>).live === null
  ) {
    throw new Error(
      `${label}: Expected a GeminiLiveClient with a .live property, ` +
      `got ${typeof value}. The installed @google/genai version may have ` +
      `changed its API surface.`,
    );
  }

  const live = (value as { live: Record<string, unknown> }).live;
  if (typeof live.connect !== 'function') {
    throw new Error(
      `${label}: Expected .live.connect to be a function, ` +
      `got ${typeof live.connect}. The installed @google/genai version may have ` +
      `changed its Live API surface.`,
    );
  }

  return value as GeminiLiveClient;
}

export interface GeminiFillerPayload {
  requestId: string;
  transcript: string;
  filler: string;
}

export interface GeminiFillerEvent extends stt.SpeechEvent {
  _geminiFillerMode: true;
}

export interface GeminiLiveSTTOptions {
  apiKey?: string;
  model?: string;
  voice?: string;
  language?: string;
  interimResults?: boolean;
  sampleRate?: number;
  systemInstruction?: string;

  /**
   * Enables filler mode where Gemini returns JSON:
   * `{ "transcript": string, "filler": string }`.
   *
   * Example:
   * ```ts
   * const stt = new GeminiLiveSTT({
   *   fillerMode: true,
   *   fillerPrompt: 'Return strict JSON with transcript and filler',
   * });
   * ```
   */
  fillerMode?: boolean;
  fillerPrompt?: string;
  fillerMinTranscriptLength?: number;

  /** Number of session reconnect attempts on websocket drop. */
  maxReconnectAttempts?: number;

  /** For tests/mocking. Defaults to `new GoogleGenAI({ apiKey })`. */
  client?: GeminiLiveClient;
}

type GeminiLiveSTTResolvedOptions = Required<Omit<GeminiLiveSTTOptions, 'client'>>;

function extractTextParts(message: unknown): string[] {
  const parts =
    (message as { serverContent?: { modelTurn?: { parts?: Array<{ text?: string }> } } })
      ?.serverContent?.modelTurn?.parts ?? [];
  const texts: string[] = [];

  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.length > 0) {
      texts.push(part.text);
    }
  }

  return texts;
}

function extractInputTranscriptionText(message: unknown): string | undefined {
  const text =
    (message as { serverContent?: { inputTranscription?: { text?: string } } })?.serverContent
      ?.inputTranscription?.text ?? '';

  if (typeof text === 'string' && text.length > 0) {
    return text;
  }

  return undefined;
}

function isTurnComplete(message: unknown): boolean {
  return Boolean(
    (message as { serverContent?: { turnComplete?: boolean } })?.serverContent?.turnComplete,
  );
}

export class GeminiLiveSTT extends stt.STT {
  label = 'gemini.live.STT';

  #opts: GeminiLiveSTTResolvedOptions;
  #client: GeminiLiveClient;
  #fillerListeners = new Set<(payload: GeminiFillerPayload) => void>();

  constructor(opts: GeminiLiveSTTOptions = {}) {
    super({
      streaming: true,
      interimResults: opts.interimResults ?? true,
      alignedTranscript: false,
    });

    this.#opts = {
      apiKey: opts.apiKey ?? process.env.GOOGLE_API_KEY ?? '',
      model: opts.model ?? DEFAULT_MODEL,
      voice: opts.voice ?? DEFAULT_VOICE,
      language: opts.language ?? 'en-US',
      interimResults: opts.interimResults ?? true,
      sampleRate: opts.sampleRate ?? DEFAULT_SAMPLE_RATE,
      systemInstruction: opts.systemInstruction ?? '',
      fillerMode: opts.fillerMode ?? false,
      fillerPrompt: opts.fillerPrompt ?? '',
      fillerMinTranscriptLength: opts.fillerMinTranscriptLength ?? 15,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
    };

    if (!this.#opts.apiKey && !opts.client) {
      throw new Error(
        'GeminiLiveSTT: API key is required. Pass apiKey or set GOOGLE_API_KEY env var.',
      );
    }

    this.#client =
      opts.client ??
      assertGeminiLiveClient(new GoogleGenAI({ apiKey: this.#opts.apiKey }), 'GeminiLiveSTT');
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('GeminiLiveSTT: only streaming is supported. Use .stream()');
  }

  get options(): Readonly<GeminiLiveSTTResolvedOptions> {
    return this.#opts;
  }

  get client(): GeminiLiveClient {
    return this.#client;
  }

  updateOptions(opts: Partial<GeminiLiveSTTOptions>): void {
    this.#opts = {
      ...this.#opts,
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.voice !== undefined ? { voice: opts.voice } : {}),
      ...(opts.language !== undefined ? { language: opts.language } : {}),
      ...(opts.interimResults !== undefined ? { interimResults: opts.interimResults } : {}),
      ...(opts.sampleRate !== undefined ? { sampleRate: opts.sampleRate } : {}),
      ...(opts.systemInstruction !== undefined
        ? { systemInstruction: opts.systemInstruction }
        : {}),
      ...(opts.fillerMode !== undefined ? { fillerMode: opts.fillerMode } : {}),
      ...(opts.fillerPrompt !== undefined ? { fillerPrompt: opts.fillerPrompt } : {}),
      ...(opts.fillerMinTranscriptLength !== undefined
        ? { fillerMinTranscriptLength: opts.fillerMinTranscriptLength }
        : {}),
      ...(opts.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: opts.maxReconnectAttempts }
        : {}),
    };

    if (opts.client) {
      this.#client = opts.client;
    }
  }

  onFiller(listener: (payload: GeminiFillerPayload) => void): () => void {
    this.#fillerListeners.add(listener);
    return () => {
      this.#fillerListeners.delete(listener);
    };
  }

  emitFiller(payload: GeminiFillerPayload): void {
    for (const listener of this.#fillerListeners) {
      try {
        listener(payload);
      } catch {
        // Ignore listener failures so STT stream is never blocked by downstream observers.
      }
    }
  }

  stream(options?: { connOptions?: APIConnectOptions }): GeminiLiveSpeechStream {
    return new GeminiLiveSpeechStream(this, options?.connOptions);
  }
}

export class GeminiLiveSpeechStream extends stt.SpeechStream {
  label = 'gemini.live.SpeechStream';

  #stt: GeminiLiveSTT;
  #logger = log();

  constructor(sttImpl: GeminiLiveSTT, connOptions?: APIConnectOptions) {
    super(sttImpl, sttImpl.options.sampleRate, connOptions);
    this.#stt = sttImpl;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid('gemini_stt_');
    const state = {
      speaking: false,
      transcriptBuffer: '',
    };

    let reconnectAttempt = 0;
    let resumeChunks: Uint8Array[] = [];

    while (!this.abortSignal.aborted && !this.closed) {
      try {
        const result = await this.#runSingleConnection({
          requestId,
          state,
          resumeChunks,
        });

        if (result.status === 'done') {
          return;
        }

        reconnectAttempt += 1;
        if (reconnectAttempt > this.#stt.options.maxReconnectAttempts) {
          const closeSuffix = result.closeEvent
            ? ` (last close code=${result.closeEvent.code ?? 'n/a'}, reason="${result.closeEvent.reason ?? ''}")`
            : '';
          throw new Error(
            `GeminiLiveSTT: reconnect limit exceeded (${this.#stt.options.maxReconnectAttempts})${closeSuffix}`,
          );
        }

        // Flush partial transcript from the dropped connection to avoid
        // garbled concatenation with post-reconnect text.
        if (state.speaking && state.transcriptBuffer.trim()) {
          this.queue.put({
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [{
              text: state.transcriptBuffer.trim(),
              language: this.#stt.options.language as never,
              startTime: 0,
              endTime: 0,
              confidence: 0,
            }],
            requestId,
          });
        }
        state.speaking = false;
        state.transcriptBuffer = '';

        resumeChunks = result.resumeChunks;
        this.#logger.warn(
          {
            reconnectAttempt,
            resumeChunkCount: resumeChunks.length,
            closeEvent: result.closeEvent,
          },
          'GeminiLiveSTT: reconnecting after websocket drop',
        );

        await this.#sleepWithAbort(this.#reconnectDelayMs(reconnectAttempt));
      } catch (error) {
        if (this.abortSignal.aborted) {
          return;
        }

        this.#logger.error({ error }, 'GeminiLiveSTT run() error');
        throw error;
      }
    }
  }

  async #runSingleConnection(args: {
    requestId: string;
    state: { speaking: boolean; transcriptBuffer: string };
    resumeChunks: Uint8Array[];
  }): Promise<{
    status: 'done' | 'disconnected';
    resumeChunks: Uint8Array[];
    closeEvent?: { code?: number; reason?: string; wasClean?: boolean };
  }> {
    const { requestId, state } = args;
    const opts = this.#stt.options;

    const sessionConfig: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: opts.voice,
          },
        },
      },
      inputAudioTranscription: {},
    };

    if (opts.fillerMode) {
      sessionConfig.systemInstruction = {
        parts: [
          {
            text: buildFillerInstruction({
              baseInstruction: opts.systemInstruction,
              fillerPrompt: opts.fillerPrompt,
              fillerMinTranscriptLength: opts.fillerMinTranscriptLength,
            }),
          },
        ],
      };
    } else if (opts.systemInstruction) {
      sessionConfig.systemInstruction = {
        parts: [{ text: opts.systemInstruction }],
      };
    }

    const sessionReady = new Future<void>();
    const disconnected = new Future<void>();
    const messageChannel = lkStream.createStreamChannel<unknown>();

    let session: GeminiLiveSession | null = null;
    let localInputClosed = false;
    let unexpectedDisconnect = false;
    let closeEventDetails: { code?: number; reason?: string; wasClean?: boolean } | undefined;

    session = await this.#stt.client.live.connect({
      model: opts.model,
      config: sessionConfig,
      callbacks: {
        onopen: () => {
          sessionReady.resolve();
        },
        onmessage: (message) => {
          void messageChannel.write(message).catch(() => {
            // Ignore writes after close.
          });
        },
        onerror: (error) => {
          this.#logger.error(
            { error: error instanceof Error ? error : String(error) },
            'GeminiLiveSTT websocket error',
          );
          if (!disconnected.done) {
            unexpectedDisconnect = true;
            disconnected.resolve();
          }
          void messageChannel.close().catch(() => {});
        },
        onclose: (event) => {
          const closeEvent = event as { code?: number; reason?: string; wasClean?: boolean };
          closeEventDetails = {
            code: closeEvent?.code,
            reason: closeEvent?.reason,
            wasClean: closeEvent?.wasClean,
          };
          if (!disconnected.done) {
            unexpectedDisconnect = true;
            disconnected.resolve();
          }
          void messageChannel.close().catch(() => {});
        },
      },
    });

    await sessionReady.await;

    const resumeChunks = [...args.resumeChunks];

    const inputIterator = this.input[Symbol.asyncIterator]();

    const readInputTask = async () => {
      const processor = new GeminiAudioFrameProcessor(opts.sampleRate);
      let sentAudioSinceStreamEnd = false;

      for (const chunk of resumeChunks) {
        session!.sendRealtimeInput({ media: processor.wrap(chunk) });
        sentAudioSinceStreamEnd = true;
      }

      while (!this.abortSignal.aborted && !this.closed) {
        const next = await Promise.race([
          inputIterator.next().then((value) => ({ kind: 'input' as const, value })),
          disconnected.await.then(() => ({ kind: 'disconnect' as const })),
        ]);

        if (next.kind === 'disconnect') {
          return;
        }

        if (next.value.done) {
          localInputClosed = true;
          if (sentAudioSinceStreamEnd) {
            session!.sendRealtimeInput({ audioStreamEnd: true });
            sentAudioSinceStreamEnd = false;
          }
          return;
        }

        if (next.value.value === GeminiLiveSpeechStream.FLUSH_SENTINEL) {
          const raw: Uint8Array[] = [];
          const blobs = processor.flush(raw);
          for (let i = 0; i < blobs.length; i++) {
            this.#rememberChunk(resumeChunks, raw[i]!);
            session!.sendRealtimeInput({ media: blobs[i]! });
            sentAudioSinceStreamEnd = true;
          }
          continue;
        }

        const frame = next.value.value as PCMFrame;
        const raw: Uint8Array[] = [];
        const blobs = processor.process(frame, raw);
        for (let i = 0; i < blobs.length; i++) {
          this.#rememberChunk(resumeChunks, raw[i]!);
          session!.sendRealtimeInput({ media: blobs[i]! });
          sentAudioSinceStreamEnd = true;
        }
      }
    };

    const receiveTask = async () => {
      const reader = messageChannel.stream().getReader();
      try {
        while (!this.abortSignal.aborted && !this.closed) {
          const result = await reader.read();
          if (result.done) {
            return;
          }

          const message = result.value;
          const inputTranscriptionText = extractInputTranscriptionText(message);
          const texts = inputTranscriptionText
            ? [inputTranscriptionText]
            : extractTextParts(message);

          for (const text of texts) {
            if (!state.speaking) {
              state.speaking = true;
              if (!this.queue.closed) {
                this.queue.put({
                  type: stt.SpeechEventType.START_OF_SPEECH,
                  requestId,
                });
              }
            }

            if (inputTranscriptionText) {
              // Gemini input transcription can be cumulative across events.
              if (text.startsWith(state.transcriptBuffer)) {
                state.transcriptBuffer = text;
              } else if (text !== state.transcriptBuffer) {
                state.transcriptBuffer += text;
              }
            } else {
              state.transcriptBuffer += text;
            }

            if (opts.interimResults && !opts.fillerMode && !this.queue.closed) {
              this.queue.put({
                type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
                requestId,
                alternatives: [
                  {
                    text: state.transcriptBuffer,
                    language: opts.language as never,
                    startTime: 0,
                    endTime: 0,
                    confidence: 0.9,
                  },
                ],
              });
            }
          }

          if (isTurnComplete(message) && state.speaking) {
            this.#emitTurnComplete({
              requestId,
              language: opts.language,
              transcriptBuffer: state.transcriptBuffer,
              fillerMode: opts.fillerMode,
              fillerMinTranscriptLength: opts.fillerMinTranscriptLength,
            });

            state.speaking = false;
            state.transcriptBuffer = '';

            if (!this.queue.closed) {
              this.queue.put({
                type: stt.SpeechEventType.END_OF_SPEECH,
                requestId,
              });
            }
          }
        }
      } finally {
        reader.releaseLock();
        await messageChannel.close().catch(() => {});
      }
    };

    // Use an AbortController so that if receiveTask fails, readInputTask
    // is signaled to stop rather than hanging on inputIterator.next().
    const taskAbort = new AbortController();
    try {
      await Promise.all([
        readInputTask().catch((err) => { taskAbort.abort(); throw err; }),
        receiveTask().catch((err) => { taskAbort.abort(); throw err; }),
      ]);
    } finally {
      taskAbort.abort();
      await Promise.resolve(session?.close()).catch(() => {});
    }

    if (unexpectedDisconnect && !localInputClosed && !this.abortSignal.aborted && !this.closed) {
      this.#logger.warn(
        { closeEvent: closeEventDetails },
        'GeminiLiveSTT websocket closed unexpectedly; attempting reconnect',
      );
      return {
        status: 'disconnected',
        resumeChunks,
        closeEvent: closeEventDetails,
      };
    }

    return {
      status: localInputClosed ? 'done' : 'disconnected',
      resumeChunks,
      closeEvent: closeEventDetails,
    };
  }

  #reconnectDelayMs(attempt: number): number {
    const base = Math.min(
      MAX_RECONNECT_DELAY_MS,
      DEFAULT_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    );
    const jitter = Math.floor(Math.random() * 120);
    return base + jitter;
  }

  async #sleepWithAbort(ms: number): Promise<void> {
    if (ms <= 0 || this.abortSignal.aborted || this.closed) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.abortSignal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      this.abortSignal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #rememberChunk(buffer: Uint8Array[], bytes: Uint8Array): void {
    if (buffer.length >= RESUME_BUFFER_LIMIT) {
      buffer.shift();
    }
    buffer.push(bytes);
  }

  #emitTurnComplete(args: {
    requestId: string;
    language: string;
    transcriptBuffer: string;
    fillerMode: boolean;
    fillerMinTranscriptLength: number;
  }): void {
    const payload = parseFillerResponse(args.transcriptBuffer);
    const transcript = payload.transcript.trim();
    const filler = payload.filler.trim();

    if (!transcript && !filler) {
      return;
    }

    if (
      args.fillerMode &&
      filler &&
      transcript.length >= args.fillerMinTranscriptLength &&
      !this.queue.closed
    ) {
      const fillerEvent: GeminiFillerEvent = {
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        requestId: args.requestId,
        alternatives: [
          {
            text: filler,
            language: asLanguageCode(args.language),
            startTime: 0,
            endTime: 0,
            confidence: 1,
          },
        ],
        _geminiFillerMode: true,
      };

      this.queue.put(fillerEvent);
      this.#stt.emitFiller({
        requestId: args.requestId,
        transcript,
        filler,
      });
    }

    if (!this.queue.closed && transcript) {
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        requestId: args.requestId,
        alternatives: [
          {
            text: transcript,
            language: args.language as never,
            startTime: 0,
            endTime: 0,
            confidence: payload.parsedAsJson ? 0.95 : 0.9,
          },
        ],
      });
    }
  }
}
