import {
  type APIConnectOptions,
  Future,
  log,
  shortuuid,
  stream as lkStream,
  tokenize,
  tts,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { GoogleGenAI, Modality } from '@google/genai';
import { assertGeminiLiveClient, type GeminiLiveClient, type GeminiLiveSession } from './stt.js';
import { GeminiSynthesisQueue } from './synthesis_queue.js';

const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const DEFAULT_SENTENCE_BUFFER_WORDS = 6;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 60_000;

type LiveCloseEventDetails = {
  code?: number;
  reason?: string;
  wasClean?: boolean;
};

export type GeminiVoice = string;

export interface GeminiLiveTTSOptions {
  apiKey?: string;
  model?: string;
  voice?: GeminiVoice;
  outputSampleRate?: number;
  systemInstruction?: string;
  sentenceBufferWords?: number;
  sessionIdleTimeoutMs?: number;
  client?: GeminiLiveClient;
}

type GeminiLiveTTSResolvedOptions = Required<Omit<GeminiLiveTTSOptions, 'client'>>;

function extractInlineAudioParts(message: unknown): Array<{ mimeType: string; data: string }> {
  const parts =
    (message as {
      serverContent?: { modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } };
    })?.serverContent?.modelTurn?.parts ?? [];

  const audioParts: Array<{ mimeType: string; data: string }> = [];
  for (const part of parts) {
    const inlineData = part?.inlineData;
    if (
      inlineData &&
      typeof inlineData.mimeType === 'string' &&
      inlineData.mimeType.startsWith('audio/') &&
      typeof inlineData.data === 'string' &&
      inlineData.data.length > 0
    ) {
      audioParts.push({ mimeType: inlineData.mimeType, data: inlineData.data });
    }
  }

  return audioParts;
}

function isTurnComplete(message: unknown): boolean {
  return Boolean(
    (message as { serverContent?: { turnComplete?: boolean } })?.serverContent?.turnComplete,
  );
}


export class GeminiLiveTTS extends tts.TTS {
  label = 'gemini.live.TTS';

  #opts: GeminiLiveTTSResolvedOptions;
  #client: GeminiLiveClient;
  #logger = log();

  #liveSession: GeminiLiveSession | null = null;
  #liveSessionConfigKey: string | null = null;
  #liveSessionBusy = false;
  #liveSessionWaiters: Array<() => void> = [];
  #liveSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;
  #activeMessageChannel: ReturnType<typeof lkStream.createStreamChannel<unknown>> | null = null;
  #activeCloseEventDetails: LiveCloseEventDetails | undefined;
  #sessionDirty = false;

  constructor(opts: GeminiLiveTTSOptions = {}) {
    const outputSampleRate = opts.outputSampleRate ?? DEFAULT_OUTPUT_SAMPLE_RATE;

    super(outputSampleRate, NUM_CHANNELS, {
      streaming: true,
      alignedTranscript: false,
    });

    this.#opts = {
      apiKey: opts.apiKey ?? process.env.GOOGLE_API_KEY ?? '',
      model: opts.model ?? DEFAULT_MODEL,
      voice: opts.voice ?? 'Kore',
      outputSampleRate,
      systemInstruction: opts.systemInstruction ?? '',
      sentenceBufferWords: opts.sentenceBufferWords ?? DEFAULT_SENTENCE_BUFFER_WORDS,
      sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    };

    if (!this.#opts.apiKey && !opts.client) {
      throw new Error(
        'GeminiLiveTTS: API key is required. Pass apiKey or set GOOGLE_API_KEY env var.',
      );
    }

    this.#client =
      opts.client ??
      assertGeminiLiveClient(new GoogleGenAI({ apiKey: this.#opts.apiKey }), 'GeminiLiveTTS');
  }

  get options(): Readonly<GeminiLiveTTSResolvedOptions> {
    return this.#opts;
  }

  get client(): GeminiLiveClient {
    return this.#client;
  }

  updateOptions(opts: Partial<GeminiLiveTTSOptions>): void {
    this.#opts = {
      ...this.#opts,
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.voice !== undefined ? { voice: opts.voice } : {}),
      ...(opts.outputSampleRate !== undefined
        ? { outputSampleRate: opts.outputSampleRate }
        : {}),
      ...(opts.systemInstruction !== undefined
        ? { systemInstruction: opts.systemInstruction }
        : {}),
      ...(opts.sentenceBufferWords !== undefined
        ? { sentenceBufferWords: opts.sentenceBufferWords }
        : {}),
      ...(opts.sessionIdleTimeoutMs !== undefined
        ? { sessionIdleTimeoutMs: opts.sessionIdleTimeoutMs }
        : {}),
    };

    if (opts.client) {
      this.#client = opts.client;
    }

    this.#sessionDirty = true;
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): GeminiLiveChunkedStream {
    return new GeminiLiveChunkedStream(text, this, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): GeminiLiveSynthesizeStream {
    return new GeminiLiveSynthesizeStream(this, options?.connOptions);
  }

  createLiveSessionConfig(): Record<string, unknown> {
    const opts = this.#opts;
    const sessionConfig: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: opts.voice,
          },
        },
      },
    };

    if (opts.systemInstruction) {
      sessionConfig.systemInstruction = {
        parts: [{ text: opts.systemInstruction }],
      };
    }

    return sessionConfig;
  }

  getActiveCloseEventDetails(): LiveCloseEventDetails | undefined {
    return this.#activeCloseEventDetails;
  }

  async acquireLiveSession(
    messageChannel: ReturnType<typeof lkStream.createStreamChannel<unknown>>,
    abortSignal: AbortSignal,
  ): Promise<{
    session: GeminiLiveSession;
    release: () => Promise<void>;
  }> {
    await this.#waitForSessionAvailability(abortSignal);
    this.#liveSessionBusy = true;
    this.#clearIdleSessionTimer();
    this.#activeMessageChannel = messageChannel;
    this.#activeCloseEventDetails = undefined;

    try {
      const sessionConfig = this.createLiveSessionConfig();
      const sessionConfigKey = this.#sessionConfigKey(sessionConfig);
      if (
        this.#liveSession &&
        (this.#sessionDirty || this.#liveSessionConfigKey !== sessionConfigKey)
      ) {
        this.#logger.debug('GeminiLiveTTS: replacing shared live session due to option/config change');
        await this.#closeLiveSession();
      }

      if (!this.#liveSession) {
        this.#logger.debug('GeminiLiveTTS: creating shared live session');
        const sessionReady = new Future<void>();
        const session = await this.#client.live.connect({
          model: this.#opts.model,
          config: sessionConfig,
          callbacks: {
            onopen: () => {
              if (!sessionReady.done) {
                sessionReady.resolve();
              }
            },
            onmessage: (message) => {
              const channel = this.#activeMessageChannel;
              if (!channel) {
                return;
              }
              void channel.write(message).catch(() => {
                // Ignore writes after close.
              });
            },
            onerror: (error) => {
              this.#logger.warn(
                { error: error instanceof Error ? error.message : String(error) },
                'GeminiLiveTTS websocket error',
              );
              const channel = this.#activeMessageChannel;
              if (channel) {
                void channel.close().catch(() => {});
              }
            },
            onclose: (event) => {
              const closeEvent = event as LiveCloseEventDetails;
              this.#activeCloseEventDetails = {
                code: closeEvent?.code,
                reason: closeEvent?.reason,
                wasClean: closeEvent?.wasClean,
              };
              this.#liveSession = null;
              this.#liveSessionConfigKey = null;
              this.#sessionDirty = false;
              const channel = this.#activeMessageChannel;
              if (channel) {
                void channel.close().catch(() => {});
              }
            },
          },
        });

        if (!sessionReady.done) {
          sessionReady.resolve();
        }
        await sessionReady.await;
        this.#liveSession = session;
        this.#liveSessionConfigKey = sessionConfigKey;
        this.#sessionDirty = false;
      } else {
        this.#logger.debug('GeminiLiveTTS: reusing shared live session');
      }

      return {
        session: this.#liveSession,
        release: async () => {
          this.#activeMessageChannel = null;
          this.#activeCloseEventDetails = undefined;
          this.#liveSessionBusy = false;
          this.#notifySessionWaiter();
          this.#scheduleIdleSessionClose();
        },
      };
    } catch (error) {
      this.#activeMessageChannel = null;
      this.#activeCloseEventDetails = undefined;
      this.#liveSessionBusy = false;
      this.#notifySessionWaiter();
      throw error;
    }
  }

  async closeLiveSessionNow(): Promise<void> {
    this.#clearIdleSessionTimer();
    await this.#closeLiveSession();
  }

  /**
   * Close the TTS instance, clearing idle timers and releasing the live session.
   * Call this when the TTS is no longer needed to prevent timer leaks.
   */
  async close(): Promise<void> {
    this.#clearIdleSessionTimer();
    await this.#closeLiveSession();
  }

  async #closeLiveSession(): Promise<void> {
    if (!this.#liveSession) {
      return;
    }
    const session = this.#liveSession;
    this.#liveSession = null;
    this.#liveSessionConfigKey = null;
    await Promise.resolve(session.close()).catch(() => {});
  }

  #sessionConfigKey(sessionConfig: Record<string, unknown>): string {
    return JSON.stringify({
      model: this.#opts.model,
      voice: this.#opts.voice,
      systemInstruction: this.#opts.systemInstruction,
      sessionConfig,
    });
  }

  async #waitForSessionAvailability(abortSignal: AbortSignal): Promise<void> {
    while (this.#liveSessionBusy) {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          abortSignal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          this.#liveSessionWaiters = this.#liveSessionWaiters.filter((item) => item !== waiter);
          reject(new Error('GeminiLiveTTS: aborted while waiting for shared session'));
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        this.#liveSessionWaiters.push(waiter);
      });
    }
  }

  #notifySessionWaiter(): void {
    const waiter = this.#liveSessionWaiters.shift();
    waiter?.();
  }

  #clearIdleSessionTimer(): void {
    if (this.#liveSessionIdleTimer) {
      clearTimeout(this.#liveSessionIdleTimer);
      this.#liveSessionIdleTimer = null;
    }
  }

  #scheduleIdleSessionClose(): void {
    this.#clearIdleSessionTimer();
    if (!this.#liveSession || this.#liveSessionBusy) {
      return;
    }
    this.#liveSessionIdleTimer = setTimeout(() => {
      this.#liveSessionIdleTimer = null;
      if (this.#liveSessionBusy) {
        return;
      }
      this.#logger.debug('GeminiLiveTTS: closing idle shared live session');
      void this.#closeLiveSession();
    }, this.#opts.sessionIdleTimeoutMs);
  }
}

export class GeminiLiveSynthesizeStream extends tts.SynthesizeStream {
  label = 'gemini.live.SynthesizeStream';

  #tts: GeminiLiveTTS;
  #logger = log();

  constructor(ttsImpl: GeminiLiveTTS, connOptions?: APIConnectOptions) {
    super(ttsImpl, connOptions);
    this.#tts = ttsImpl;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid('gemini_tts_');
    const opts = this.#tts.options;
    const messageChannel = lkStream.createStreamChannel<unknown>();
    const lease = await this.#tts.acquireLiveSession(messageChannel, this.abortSignal);
    const session = lease.session;
    const runStartedAt = Date.now();
    let firstTextSentAt: number | null = null;
    let firstAudioAt: number | null = null;
    let audioBytesReceived = 0;
    let audioFrameCount = 0;

    this.#logger.info(
      { requestId, model: opts.model, voice: opts.voice },
      'GeminiLiveTTS: synth stream started',
    );

    const sentenceTokenizer = new tokenize.basic.SentenceTokenizer({
      minSentenceLength: opts.sentenceBufferWords,
    }).stream();

    const inputTask = async () => {
      for await (const item of this.input) {
        if (item === GeminiLiveSynthesizeStream.FLUSH_SENTINEL) {
          sentenceTokenizer.flush();
          continue;
        }
        sentenceTokenizer.pushText(item as string);
      }
      sentenceTokenizer.endInput();
      sentenceTokenizer.close();
    };

    const sendTask = async () => {
      let sentAnyText = false;
      for await (const event of sentenceTokenizer) {
        if (this.abortSignal.aborted) {
          return;
        }
        const text = `${event.token}`.trim();
        if (!text) {
          continue;
        }
        sentAnyText = true;
        if (firstTextSentAt === null) {
          firstTextSentAt = Date.now();
          this.#logger.info(
            { requestId, msSinceRunStart: firstTextSentAt - runStartedAt },
            'GeminiLiveTTS: first text chunk sent to live API',
          );
        }

        if (typeof session.sendClientContent === 'function') {
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: false,
          });
        } else {
          session.sendRealtimeInput({ text: `${text} ` });
        }
      }

      if (typeof session.sendClientContent === 'function') {
        if (sentAnyText) {
          // `@google/genai` rejects empty `turns` arrays. For turn finalization
          // without adding new content, send only `turnComplete`.
          session.sendClientContent({ turnComplete: true });
          this.#logger.info({ requestId }, 'GeminiLiveTTS: turnComplete sent to live API');
        }
      }
    };

    const receiveTask = async () => {
      const synth = new GeminiSynthesisQueue(opts.outputSampleRate, NUM_CHANNELS);
      const segmentId = requestId;
      const reader = messageChannel.stream().getReader();
      let lastFrame: AudioFrame | undefined;
      let gotTurnComplete = false;
      const RECEIVE_TIMEOUT_MS = 30_000;

      const emitLastFrame = (final: boolean) => {
        if (!lastFrame || this.queue.closed) {
          return;
        }

        this.queue.put({
          requestId,
          segmentId,
          frame: lastFrame,
          final,
        });
        lastFrame = undefined;
      };

      try {
        while (!this.abortSignal.aborted && !this.closed) {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('GeminiLiveTTS: receiveTask timed out waiting for turnComplete')), RECEIVE_TIMEOUT_MS);
          });
          let result: Awaited<ReturnType<typeof reader.read>>;
          try {
            result = await Promise.race([reader.read(), timeoutPromise]) as Awaited<ReturnType<typeof reader.read>>;
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
          if (result.done) {
            if (!gotTurnComplete && !this.abortSignal.aborted && !this.closed) {
              const closeEventDetails = this.#tts.getActiveCloseEventDetails();
              const closeSuffix = closeEventDetails
                ? ` (close code=${closeEventDetails.code ?? 'n/a'}, reason="${closeEventDetails.reason ?? ''}")`
                : '';
              throw new Error(`GeminiLiveTTS websocket closed before turnComplete${closeSuffix}`);
            }
            break;
          }

          const message = result.value;
          const audioParts = extractInlineAudioParts(message);

          for (const part of audioParts) {
            if (firstAudioAt === null) {
              firstAudioAt = Date.now();
              this.#logger.info(
                {
                  requestId,
                  msSinceRunStart: firstAudioAt - runStartedAt,
                  msFromFirstText:
                    firstTextSentAt === null ? null : firstAudioAt - firstTextSentAt,
                },
                'GeminiLiveTTS: first audio chunk received from live API',
              );
            }
            for (const frame of synth.ingest(part.data)) {
              emitLastFrame(false);
              lastFrame = frame;
            }
          }

          if (isTurnComplete(message)) {
            gotTurnComplete = true;
            for (const frame of synth.flush()) {
              emitLastFrame(false);
              lastFrame = frame;
            }
            emitLastFrame(true);

            if (!this.queue.closed) {
              this.queue.put(GeminiLiveSynthesizeStream.END_OF_STREAM);
            }
            audioBytesReceived = synth.bytesReceived;
            audioFrameCount = synth.frameCount;
            this.#logger.info(
              {
                requestId,
                totalMs: Date.now() - runStartedAt,
                audioBytesReceived,
                audioFrameCount,
              },
              'GeminiLiveTTS: stream completed',
            );
            break;
          }
        }
      } finally {
        reader.releaseLock();
        await messageChannel.close().catch(() => {});
      }
    };

    try {
      await Promise.all([inputTask(), sendTask(), receiveTask()]);
    } catch (error) {
      if (!this.abortSignal.aborted) {
        this.#logger.error({ error }, 'GeminiLiveTTS run() error');
        throw error;
      }
    } finally {
      await lease.release();
      await messageChannel.close().catch(() => {});
    }
  }
}

export class GeminiLiveChunkedStream extends tts.ChunkedStream {
  label = 'gemini.live.ChunkedStream';

  #tts: GeminiLiveTTS;
  #logger = log();

  constructor(
    text: string,
    ttsImpl: GeminiLiveTTS,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, ttsImpl, connOptions, abortSignal);
    this.#tts = ttsImpl;
  }

  protected async run(): Promise<void> {
    const requestId = shortuuid('gemini_tts_chunk_');
    const opts = this.#tts.options;

    const models = this.#tts.client.models;
    if (!models?.generateContentStream) {
      throw new Error('GeminiLiveTTS: client.models.generateContentStream is not available');
    }

    let lastFrame: AudioFrame | undefined;
    const synth = new GeminiSynthesisQueue(opts.outputSampleRate, NUM_CHANNELS);

    const emitLastFrame = (final: boolean) => {
      if (!lastFrame || this.queue.closed) {
        return;
      }

      this.queue.put({
        requestId,
        segmentId: requestId,
        frame: lastFrame,
        final,
      });
      lastFrame = undefined;
    };

    try {
      const responseStream = await models.generateContentStream({
        model: opts.model,
        contents: [{ role: 'user', parts: [{ text: this.inputText }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: opts.voice,
              },
            },
          },
          abortSignal: this.abortSignal,
        },
      });

      for await (const chunk of responseStream) {
        const parts =
          (chunk as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }>;
              };
            }>;
          })?.candidates?.[0]?.content?.parts ?? [];

        for (const part of parts) {
          const inlineData = part?.inlineData;
          if (
            inlineData &&
            typeof inlineData.mimeType === 'string' &&
            inlineData.mimeType.startsWith('audio/') &&
            typeof inlineData.data === 'string'
          ) {
            for (const frame of synth.ingest(inlineData.data)) {
              emitLastFrame(false);
              lastFrame = frame;
            }
          }
        }
      }

      for (const frame of synth.flush()) {
        emitLastFrame(false);
        lastFrame = frame;
      }
      emitLastFrame(true);
    } catch (error) {
      if (!this.abortSignal.aborted) {
        this.#logger.error({ error }, 'GeminiLiveChunkedStream run() error');
        throw error;
      }
    }
  }
}
