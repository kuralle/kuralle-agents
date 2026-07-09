import {
  asLanguageCode,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  llm,
  stt,
  tts,
  voice,
} from '@livekit/agents';
import type { KuralleRuntimeLike } from '../src/llm/KuralleRuntimeLLMAdapter.js';
import { KuralleVoiceSession } from '../src/session/KuralleVoiceSession.js';
import { TransportAdapter } from '../src/transport_adapter.js';
import { AudioInput, AudioOutput, TextOutput } from '../src/livekit_io.js';
import type { TransportAdapterConfig } from '../src/types.js';
import { mockTurnHandle } from './mock_turn_handle.js';

let testLoggerInitialized = false;

function ensureTestLogger(): void {
  if (!testLoggerInitialized) {
    initializeLogger({ pretty: false, level: 'warn' });
    testLoggerInitialized = true;
  }
}

function createDefaultAgentSession(): voice.AgentSession {
  ensureTestLogger();
  return new voice.AgentSession({
    stt: createStubSTT(),
    tts: createStubTTS(),
    llm: createStubLLM(),
  });
}

class StubSpeechStream extends stt.SpeechStream {
  label = 'stub-stt';

  protected async run(): Promise<void> {}
}

export class StubSTT extends stt.STT {
  label = 'stub-stt';

  constructor() {
    super({ streaming: true, interimResults: true });
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: '',
          language: asLanguageCode('en-US'),
          startTime: 0,
          endTime: 0,
          confidence: 1,
        },
      ],
    };
  }

  stream() {
    return new StubSpeechStream(this);
  }
}

class StubSynthesizeStream extends tts.SynthesizeStream {
  label = 'stub-tts';

  protected async run(): Promise<void> {}
}

class StubChunkedStream extends tts.ChunkedStream {
  label = 'stub-tts';

  protected async run(): Promise<void> {}
}

export class StubTTS extends tts.TTS {
  label = 'stub-tts';

  constructor() {
    super(24000, 1, { streaming: true });
  }

  synthesize(text: string) {
    return new StubChunkedStream(text, this);
  }

  stream() {
    return new StubSynthesizeStream(this);
  }
}

class StubLLMStream extends llm.LLMStream {
  protected async run(): Promise<void> {}
}

export class StubLLM extends llm.LLM {
  label(): string {
    return 'stub-llm';
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: typeof DEFAULT_API_CONNECT_OPTIONS;
  }) {
    return new StubLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
    });
  }
}

export function createStubSTT(): stt.STT {
  return new StubSTT();
}

export function createStubTTS(): tts.TTS {
  return new StubTTS();
}

export function createStubLLM(): llm.LLM {
  return new StubLLM();
}

export function createStubRuntime(): KuralleRuntimeLike {
  return {
    run() {
      return mockTurnHandle((async function* () {
        yield { type: 'done' as const, sessionId: 'test' };
      })());
    },
  };
}

class StubAudioInput extends AudioInput {}

class StubAudioOutput extends AudioOutput {
  clearBuffer(): void {}
}

class StubTextOutput extends TextOutput {
  async captureText(): Promise<void> {}

  flush(): void {}
}

export interface TestTransportAdapterOptions {
  id: string;
  isOpen?: boolean;
  close?: () => Promise<void>;
  config?: TransportAdapterConfig;
}

class TestTransportAdapter extends TransportAdapter {
  readonly id: string;
  readonly audioInput = new StubAudioInput();
  readonly audioOutput = new StubAudioOutput();
  readonly textOutput = new StubTextOutput();
  readonly config: TransportAdapterConfig;
  readonly #closeFn: () => Promise<void>;
  #open: boolean;

  constructor(opts: TestTransportAdapterOptions) {
    super();
    this.id = opts.id;
    this.#open = opts.isOpen ?? true;
    this.#closeFn = opts.close ?? (async () => {});
    this.config = opts.config ?? {
      sampleRate: 24000,
      numChannels: 1,
      encoding: 'pcm_s16le',
      samplesPerChannel: null,
    };
  }

  get isOpen(): boolean {
    return this.#open;
  }

  async close(): Promise<void> {
    this.#open = false;
    await this.#closeFn();
  }
}

export function createTestTransportAdapter(
  opts: TestTransportAdapterOptions & { className?: string },
): TransportAdapter {
  const { className = 'TestAdapter', ...adapterOpts } = opts;
  const AdapterClass = {
    [className]: class extends TestTransportAdapter {
      constructor() {
        super(adapterOpts);
      }
    },
  }[className]!;
  return new AdapterClass();
}

export interface TestVoiceSessionHandlers {
  start?: (adapter: TransportAdapter) => Promise<voice.AgentSession>;
  close?: () => Promise<void>;
}

export class TestVoiceSession extends KuralleVoiceSession {
  readonly #handlers: TestVoiceSessionHandlers;
  #defaultAgentSession: voice.AgentSession | null = null;

  constructor(handlers: TestVoiceSessionHandlers = {}) {
    const sttPlugin = createStubSTT();
    const ttsPlugin = createStubTTS();
    super({
      runtime: createStubRuntime(),
      stt: sttPlugin,
      tts: ttsPlugin,
      greeting: null,
    });

    this.#handlers = handlers;
  }

  override async start(adapter: TransportAdapter): Promise<voice.AgentSession> {
    if (this.#handlers.start) {
      return this.#handlers.start(adapter);
    }

    if (!this.#defaultAgentSession) {
      this.#defaultAgentSession = createDefaultAgentSession();
    }
    return this.#defaultAgentSession;
  }

  override async close(): Promise<void> {
    if (this.#handlers.close) {
      return this.#handlers.close();
    }
  }
}

export type FillerSpeakSession = Pick<voice.AgentSession, 'say'>;

export function createAgentSessionForMetrics(): voice.AgentSession {
  return createDefaultAgentSession();
}

ensureTestLogger();
