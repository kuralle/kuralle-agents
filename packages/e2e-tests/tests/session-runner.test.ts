import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { AudioFrame } from '@livekit/rtc-node';
import { llm } from '@livekit/agents';
import { LiveKitSessionRunner, type NativeAudioTransport } from '@kuralle-agents/livekit-plugin';
import { FakeRealtimeAudioClient } from '../harness/fake_realtime_client.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function makeGenerationWithAudioAndTool(
  toolName: string,
  argsObj: Record<string, unknown>,
): llm.GenerationCreatedEvent {
  const messageStream = new ReadableStream<llm.MessageGeneration>({
    start(controller) {
      const audioStream = new ReadableStream<AudioFrame>({
        start(c) {
          const samples = new Int16Array([42, -42, 0]);
          c.enqueue(new AudioFrame(samples, 24000, 1, samples.length));
          c.close();
        },
      });
      const textStream = new ReadableStream<string>({
        start(c) {
          c.close();
        },
      });
      controller.enqueue({ audioStream, textStream });
      controller.close();
    },
  });
  const functionStream = new ReadableStream<llm.FunctionCall>({
    start(c) {
      c.enqueue(
        new llm.FunctionCall({
          callId: 'call-runner-1',
          name: toolName,
          args: JSON.stringify(argsObj),
        }),
      );
      c.close();
    },
  });
  return {
    messageStream,
    functionStream,
    userInitiated: true,
  };
}

class MemTransport implements NativeAudioTransport {
  readonly sent: Uint8Array[] = [];
  private readonly audioHandlers = new Set<(data: Uint8Array) => void>();
  private readonly closeHandlers = new Set<() => void>();
  closed = false;

  sendAudio(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }

  onAudio(handler: (data: Uint8Array) => void): void {
    this.audioHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) {
      try {
        h();
      } catch {
        /* ignore */
      }
    }
  }

  pushPcmBytes(bytes: Uint8Array): void {
    for (const h of this.audioHandlers) {
      try {
        h(bytes);
      } catch {
        /* ignore */
      }
    }
  }
}

class FakeAdapter {
  attached = false;
  detached = false;
  private turnRelease?: () => void;
  private turnPromise: Promise<void> = Promise.resolve();

  constructor(options?: { turnDelayMs?: number }) {
    const delay = options?.turnDelayMs ?? 0;
    if (delay > 0) {
      this.turnPromise = new Promise<void>((resolve) => {
        this.turnRelease = () => {
          setTimeout(resolve, delay);
        };
      });
    }
  }

  releaseTurn(): void {
    this.turnRelease?.();
  }

  async attach(_session: unknown): Promise<void> {
    await Promise.resolve();
    this.attached = true;
  }

  async detach(): Promise<void> {
    this.detached = true;
  }

  async onTurnComplete(): Promise<void> {
    await this.turnPromise;
  }
}

class FakeSession extends EventEmitter {
  chatCtx = llm.ChatContext.empty();
  tools: llm.ToolContext = {};
  pushAudioFrames: AudioFrame[] = [];
  updateChatCtxCalls = 0;
  closed = false;
  private readonly outputCallIds = new Set<string>();
  private readonly fakeGemini?: FakeRealtimeAudioClient;

  constructor(fakeGemini?: FakeRealtimeAudioClient) {
    super();
    this.fakeGemini = fakeGemini;
  }

  pushAudio(frame: AudioFrame): void {
    this.pushAudioFrames.push(frame);
  }

  async updateChatCtx(ctx: llm.ChatContext): Promise<void> {
    this.updateChatCtxCalls += 1;
    this.chatCtx = ctx.copy();
    if (!this.fakeGemini) return;
    for (const item of ctx.items) {
      if (item.type !== 'function_call_output') continue;
      if (this.outputCallIds.has(item.callId)) continue;
      this.outputCallIds.add(item.callId);
      let output: unknown = item.output;
      try {
        output = JSON.parse(item.output) as unknown;
      } catch {
        /* keep string */
      }
      this.fakeGemini.sendToolResponse([{ id: item.callId, name: item.name, output }]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('LiveKitSessionRunner', () => {
  test('forwards model audio through transport.sendAudio and PCM ingress to pushAudio', async () => {
    const session = new FakeSession();
    const adapter = new FakeAdapter();
    const transport = new MemTransport();
    const runner = new LiveKitSessionRunner({ session, adapter, transport, sessionId: 'r1' });
    await runner.start();

    session.emit('generation_created', makeGenerationWithAudioAndTool('noop', {}));
    await flushMicrotasks();
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(transport.sent.length).toBeGreaterThan(0);

    const pcm = new Uint8Array(4);
    pcm[0] = 10;
    pcm[1] = 0;
    pcm[2] = 20;
    pcm[3] = 0;
    transport.pushPcmBytes(pcm);
    expect(session.pushAudioFrames.length).toBe(1);

    await runner.stop('test_done');
    expect(adapter.detached).toBe(true);
    expect(session.closed).toBe(true);
  });

  test('executes tools and updates chat context', async () => {
    const fakeGemini = new FakeRealtimeAudioClient({ responses: {} });
    await fakeGemini.connect({ systemInstruction: 'x', tools: [] });

    const session = new FakeSession(fakeGemini);
    session.tools = {
      echo: {
        execute: async (args: unknown) => args,
      },
    };
    const runner = new LiveKitSessionRunner({
      session,
      adapter: new FakeAdapter(),
      transport: new MemTransport(),
    });
    await runner.start();

    session.emit('generation_created', makeGenerationWithAudioAndTool('echo', { city: 'Paris' }));
    await flushMicrotasks();
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(session.updateChatCtxCalls).toBeGreaterThan(0);
    const out = session.chatCtx.items.filter((i) => i.type === 'function_call_output');
    expect(out.length).toBe(1);
    expect(fakeGemini.receivedToolResponses.length).toBe(1);

    await runner.stop('test_done');
  });

  test('invokes onTurnComplete callback only after adapter.onTurnComplete resolves', async () => {
    const marks: string[] = [];
    const adapter = new FakeAdapter({ turnDelayMs: 35 });
    const session = new FakeSession();
    const runner = new LiveKitSessionRunner({
      session,
      adapter,
      transport: new MemTransport(),
      onTurnComplete: () => marks.push('done'),
    });
    await runner.start();

    session.emit('turn_complete');
    adapter.releaseTurn();
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(marks).toEqual(['done']);

    await runner.stop('test_done');
  });

  test('invokes onUserTranscript for final transcriptions', async () => {
    const texts: string[] = [];
    const session = new FakeSession();
    const runner = new LiveKitSessionRunner({
      session,
      adapter: new FakeAdapter(),
      transport: new MemTransport(),
      onUserTranscript: (t) => texts.push(t),
    });
    await runner.start();

    session.emit('input_audio_transcription_completed', {
      itemId: 'i1',
      transcript: 'hello',
      isFinal: true,
    });
    await flushMicrotasks();
    expect(texts).toEqual(['hello']);

    await runner.stop('test_done');
  });

  test('stop is idempotent when transport closes', async () => {
    const session = new FakeSession();
    const adapter = new FakeAdapter();
    const transport = new MemTransport();
    const runner = new LiveKitSessionRunner({ session, adapter, transport });
    await runner.start();

    transport.close();
    await flushMicrotasks();
    expect(session.closed).toBe(true);

    await runner.stop('again');
    expect(adapter.detached).toBe(true);
  });
});
