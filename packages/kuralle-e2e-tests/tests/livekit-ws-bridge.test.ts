import { EventEmitter, once } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { AudioFrame } from '@livekit/rtc-node';
import { llm } from '@livekit/agents';
import WebSocket, { WebSocketServer } from 'ws';
import { bridgeLiveKitSessionToWebSocket } from '@kuralle-agents/livekit-plugin-transport-ws';
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
          callId: 'call-bridge-1',
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

class SlowAttachAdapter extends FakeAdapter {
  constructor(private readonly delayMs: number) {
    super();
  }

  override async attach(_session: unknown): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, this.delayMs));
    this.attached = true;
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

async function withWsBridge<T>(fn: (ctx: {
  client: WebSocket;
  session: FakeSession;
  adapter: FakeAdapter;
  messages: Array<{ binary: boolean; payload: unknown }>;
}) => Promise<T>): Promise<T> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const addr = wss.address();
  if (addr === null || typeof addr === 'string') throw new Error('need port');
  const port = addr.port;

  const bridgeReady = Promise.withResolvers<void>();
  const sessionRef = { current: null as FakeSession | null };
  const adapterRef = { current: null as FakeAdapter | null };
  const messages: Array<{ binary: boolean; payload: unknown }> = [];

  wss.on('connection', (ws) => {
    const session = new FakeSession();
    const adapter = new FakeAdapter();
    sessionRef.current = session;
    adapterRef.current = adapter;
    void bridgeLiveKitSessionToWebSocket(ws, session, adapter, {
      sessionId: 'unit-test',
      onSessionEnd: () => {},
    })
      .then(() => bridgeReady.resolve())
      .catch((e) => bridgeReady.reject(e));
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  client.on('message', (data, isBinary) => {
    if (isBinary) {
      messages.push({ binary: true, payload: data });
    } else {
      messages.push({ binary: false, payload: JSON.parse(data.toString()) as unknown });
    }
  });
  await once(client, 'open');
  await bridgeReady.promise;

  const session = sessionRef.current!;
  const adapter = adapterRef.current!;

  try {
    return await fn({ client, session, adapter, messages });
  } finally {
    client.close();
    await flushMicrotasks();
    await new Promise<void>((r) => setTimeout(r, 20));
    wss.close();
    await once(wss, 'close');
  }
}

describe('bridgeLiveKitSessionToWebSocket', () => {
  test('sends session_started after attach and forwards binary audio from model', async () => {
    await withWsBridge(async ({ client, session, messages }) => {
      expect(messages.some((m) => !m.binary && (m.payload as { type?: string }).type === 'session_started')).toBe(
        true,
      );

      session.emit('generation_created', makeGenerationWithAudioAndTool('noop', {}));

      await flushMicrotasks();
      await new Promise<void>((r) => setTimeout(r, 30));

      const binary = messages.filter((m) => m.binary);
      expect(binary.length).toBeGreaterThan(0);

      const raw = binary[0]!.payload;
      const pcm = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      expect(pcm.length).toBeGreaterThan(0);

      client.send(pcm, { binary: true });
      await new Promise<void>((r) => setTimeout(r, 80));
      expect(session.pushAudioFrames.length).toBe(1);
    });
  });

  test('executes tools, updates chat context, and records responses on FakeRealtimeAudioClient', async () => {
    const fakeGemini = new FakeRealtimeAudioClient({ responses: {} });
    await fakeGemini.connect({ systemInstruction: 'x', tools: [] });

    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const addr = wss.address();
    if (addr === null || typeof addr === 'string') throw new Error('need port');

    const bridgeReady = Promise.withResolvers<void>();
    let session: FakeSession | null = null;

    wss.on('connection', (ws) => {
      const s = new FakeSession(fakeGemini);
      session = s;
      s.tools = {
        echo: {
          execute: async (args: unknown) => args,
        },
      };
      const adapter = new FakeAdapter();
      void bridgeLiveKitSessionToWebSocket(ws, s, adapter, {
        sessionId: 'tool-test',
        onToolResult: () => {},
      })
        .then(() => bridgeReady.resolve())
        .catch((e) => bridgeReady.reject(e));
    });

    const client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    const jsonMsgs: unknown[] = [];
    client.on('message', (data, isBinary) => {
      if (!isBinary) jsonMsgs.push(JSON.parse(data.toString()));
    });
    await once(client, 'open');
    await bridgeReady.promise;

    session!.emit('generation_created', makeGenerationWithAudioAndTool('echo', { city: 'Paris' }));

    await flushMicrotasks();
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(session!.updateChatCtxCalls).toBeGreaterThan(0);
    const out = session!.chatCtx.items.filter((i) => i.type === 'function_call_output');
    expect(out.length).toBe(1);
    expect(fakeGemini.receivedToolResponses.length).toBe(1);
    expect(fakeGemini.receivedToolResponses[0]!.name).toBe('echo');
    expect(jsonMsgs.some((m) => (m as { type?: string }).type === 'tool_result')).toBe(true);

    client.close();
    await new Promise<void>((r) => setTimeout(r, 20));
    wss.close();
    await once(wss, 'close');
  });

  test('emits turn_complete JSON only after adapter.onTurnComplete resolves', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const addr = wss.address();
    if (addr === null || typeof addr === 'string') throw new Error('need port');

    const bridgeReady = Promise.withResolvers<void>();
    let session: FakeSession | null = null;
    const adapter = new FakeAdapter({ turnDelayMs: 40 });

    wss.on('connection', (ws) => {
      const s = new FakeSession();
      session = s;
      void bridgeLiveKitSessionToWebSocket(ws, s, adapter, { sessionId: 'tc-test' })
        .then(() => bridgeReady.resolve())
        .catch((e) => bridgeReady.reject(e));
    });

    const client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    const turnMsgs: number[] = [];
    client.on('message', (data, isBinary) => {
      if (!isBinary) {
        const p = JSON.parse(data.toString()) as { type?: string };
        if (p.type === 'turn_complete') turnMsgs.push(Date.now());
      }
    });
    await once(client, 'open');
    await bridgeReady.promise;

    const t0 = Date.now();
    session!.emit('turn_complete');
    adapter.releaseTurn();
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(turnMsgs.length).toBe(1);
    expect(turnMsgs[0]! - t0).toBeGreaterThanOrEqual(35);

    client.close();
    await new Promise<void>((r) => setTimeout(r, 20));
    wss.close();
    await once(wss, 'close');
  });

  test('forwards final user transcription as JSON', async () => {
    await withWsBridge(async ({ session, messages }) => {
      session.emit('input_audio_transcription_completed', {
        itemId: 'i1',
        transcript: 'hello there',
        isFinal: true,
      });
      await new Promise<void>((r) => setTimeout(r, 50));
      const ut = messages.find(
        (m) => !m.binary && (m.payload as { type?: string }).type === 'user_transcription',
      );
      expect(ut).toBeDefined();
      expect((ut!.payload as { text?: string }).text).toBe('hello there');
    });
  });

  test('detaches adapter and closes session when WebSocket closes', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const addr = wss.address();
    if (addr === null || typeof addr === 'string') throw new Error('need port');

    const bridgeReady = Promise.withResolvers<void>();
    let session: FakeSession | null = null;
    let adapter: FakeAdapter | null = null;

    wss.on('connection', (ws) => {
      const s = new FakeSession();
      const a = new FakeAdapter();
      session = s;
      adapter = a;
      void bridgeLiveKitSessionToWebSocket(ws, s, a, { sessionId: 'cleanup' })
        .then(() => bridgeReady.resolve())
        .catch((e) => bridgeReady.reject(e));
    });

    const client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await once(client, 'open');
    await bridgeReady.promise;

    client.close();
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(adapter!.detached).toBe(true);
    expect(session!.closed).toBe(true);

    wss.close();
    await once(wss, 'close');
  });

  test('session_started is not sent before slow attach completes', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(wss, 'listening');
    const addr = wss.address();
    if (addr === null || typeof addr === 'string') throw new Error('need port');

    const bridgeReady = Promise.withResolvers<void>();
    wss.on('connection', (ws) => {
      const s = new FakeSession();
      const a = new SlowAttachAdapter(60);
      void bridgeLiveKitSessionToWebSocket(ws, s, a, { sessionId: 'slow' })
        .then(() => bridgeReady.resolve())
        .catch((e) => bridgeReady.reject(e));
    });

    const client = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    const seen: string[] = [];
    client.on('message', (data, isBinary) => {
      if (!isBinary) seen.push((JSON.parse(data.toString()) as { type: string }).type);
    });
    await once(client, 'open');

    await new Promise<void>((r) => setTimeout(r, 20));
    expect(seen.includes('session_started')).toBe(false);

    await bridgeReady.promise;
    await new Promise<void>((r) => setTimeout(r, 80));
    expect(seen.includes('session_started')).toBe(true);

    client.close();
    await new Promise<void>((r) => setTimeout(r, 20));
    wss.close();
    await once(wss, 'close');
  });

  test('FakeRealtimeAudioClient tool batching contract (sanity for shared harness)', async () => {
    const c = new FakeRealtimeAudioClient({
      responses: {
        run: {
          toolCalls: [{ name: 'demo_tool', args: { x: 1 } }],
          text: 'Done.',
        },
      },
    });
    await c.connect({ systemInstruction: 't', tools: [] });
    const seq: string[] = [];
    c.on('tool-call', (_id, name) => seq.push(`tool:${name}`));
    c.on('turn-complete', () => seq.push('tc'));
    c.injectUserInput('run');
    expect(seq.some((s) => s.startsWith('tool:demo_tool'))).toBe(true);
    c.sendToolResponse([{ id: 't1', name: 'demo_tool', output: { ok: true } }]);
    await flushMicrotasks();
    expect(seq[seq.length - 1]).toBe('tc');
  });
});
