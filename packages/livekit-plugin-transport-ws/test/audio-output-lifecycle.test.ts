import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import { WebSocketAudioOutput } from '../src/audio_output.js';

initializeLogger({ pretty: false, level: 'error' });

type FakeWs = {
  OPEN: number;
  readyState: number;
  sent: Buffer[];
  send: (data: Buffer, options: { binary: boolean }) => void;
};

function createFrame(samples = 480): AudioFrame {
  return new AudioFrame(new Int16Array(samples), 24000, 1, samples);
}

function createFakeWs(send?: FakeWs['send']): FakeWs {
  const ws: FakeWs = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(data) {
      ws.sent.push(Buffer.from(data));
    },
  };
  if (send) ws.send = send;
  return ws;
}

async function withTimeout<T>(promise: Promise<T>, ms = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('WebSocketAudioOutput playout lifecycle', () => {
  it('resolves waitForPlayout when a captured segment is flushed', async () => {
    const ws = createFakeWs();
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    await output.captureFrame(createFrame());
    output.flush();

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(false);
    expect(event.playbackPosition).toBeGreaterThan(0);
    expect(ws.sent.length).toBe(1);
  });

  it('resolves waitForPlayout when send fails after capture', async () => {
    const output = new WebSocketAudioOutput(
      createFakeWs(() => {
        throw new Error('closed');
      }) as never,
      'test',
      24000,
    );

    await output.captureFrame(createFrame());

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
  });

  it('does not hang when clearBuffer is called before any segment exists', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    output.clearBuffer();

    const event = await withTimeout(output.waitForPlayout());
    expect(event.playbackPosition).toBe(0);
  });

  it('survives double clearBuffer during an active segment', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    output.clearBuffer();
    output.clearBuffer();

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
  });

  it('opens a fresh segment after an interrupt', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    output.clearBuffer();
    const interrupted = await withTimeout(output.waitForPlayout());
    expect(interrupted.interrupted).toBe(true);

    await output.captureFrame(createFrame());
    output.flush();
    const next = await withTimeout(output.waitForPlayout());
    expect(next.interrupted).toBe(false);
    expect(next.playbackPosition).toBeGreaterThan(0);
  });

  it('resolves waitForPlayout when closed during an active segment', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    await output.close();

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
  });
});
