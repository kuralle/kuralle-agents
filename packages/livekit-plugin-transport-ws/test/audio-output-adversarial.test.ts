/**
 * Adversarial tests for WebSocketAudioOutput.
 *
 * These tests deliberately probe race conditions, re-entrant state transitions,
 * and counter-sync edge cases between our subclass and the base AudioOutput's
 * playbackSegmentsCount / playbackFinishedCount bookkeeping.
 *
 * Every test uses a tight timeout — a hanging waitForPlayout() is a test failure.
 */
import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import { WebSocketAudioOutput } from '../src/audio_output.js';

initializeLogger({ pretty: false, level: 'error' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function withTimeout<T>(promise: Promise<T>, ms = 300): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`HUNG — waitForPlayout did not resolve within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocketAudioOutput adversarial', () => {
  // -----------------------------------------------------------------------
  // 1. flush() on a never-started segment — no captureFrame was ever called.
  //    Base class playbackSegmentsCount stays at 0, so waitForPlayout must
  //    resolve immediately (finishedCount 0 >= segmentsCount 0).
  // -----------------------------------------------------------------------
  it('flush() with zero frames never captured does not hang', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    output.flush();
    output.flush();
    output.flush();

    const event = await withTimeout(output.waitForPlayout());
    expect(event.playbackPosition).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 2. Rapid segment cycling: capture → flush → capture → flush → ...
  //    Each cycle must produce a resolved waitForPlayout. If counter sync
  //    drifts by even 1, the last waitForPlayout hangs forever.
  // -----------------------------------------------------------------------
  it('survives 20 rapid capture→flush cycles without counter drift', async () => {
    const ws = createFakeWs();
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    for (let i = 0; i < 20; i++) {
      await output.captureFrame(createFrame());
      output.flush();
      // Let setImmediate drain fire between cycles
      await new Promise((r) => setImmediate(r));
    }

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(false);
    expect(ws.sent.length).toBe(20);
  });

  // -----------------------------------------------------------------------
  // 3. Alternating clearBuffer and flush on the same segment.
  //    clearBuffer should win (interrupted), and the subsequent flush
  //    must not double-count the segment.
  // -----------------------------------------------------------------------
  it('clearBuffer then flush on same segment does not double-finish', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    output.clearBuffer();  // finishes segment as interrupted
    output.flush();        // segment already finished — must be a no-op

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. flush then clearBuffer on same segment.
  //    flush finishes as non-interrupted. clearBuffer after that must not
  //    emit a second onPlaybackFinished.
  // -----------------------------------------------------------------------
  it('flush then clearBuffer on same segment does not double-finish', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    // flush sets flushed=true; if queue is empty, finishes immediately
    output.flush();
    output.clearBuffer(); // segment already finished — no-op

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 5. WS send throws on the first frame of a NEW segment after a previous
  //    successful segment. The second segment must resolve as interrupted,
  //    not hang or corrupt the first segment's result.
  // -----------------------------------------------------------------------
  it('send failure on second segment does not corrupt first segment result', async () => {
    let callCount = 0;
    const ws = createFakeWs((data) => {
      callCount++;
      if (callCount > 1) throw new Error('connection reset');
      ws.sent.push(Buffer.from(data));
    });
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    // Segment 1: succeeds
    await output.captureFrame(createFrame());
    output.flush();
    await new Promise((r) => setImmediate(r));
    const first = await withTimeout(output.waitForPlayout());
    expect(first.interrupted).toBe(false);

    // Segment 2: send throws
    await output.captureFrame(createFrame());
    const second = await withTimeout(output.waitForPlayout());
    expect(second.interrupted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. captureFrame after close — must not resurrect state or hang.
  // -----------------------------------------------------------------------
  it('captureFrame after close is silently ignored', async () => {
    const ws = createFakeWs();
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    await output.close();
    await output.captureFrame(createFrame());
    await output.captureFrame(createFrame());
    output.flush();

    const event = await withTimeout(output.waitForPlayout());
    expect(ws.sent.length).toBe(0);
    // close() on an output with no active segment resolves with the default
    // event (interrupted: false, playbackPosition: 0) — there was nothing
    // to interrupt. The captureFrame calls after close are silently dropped.
    expect(event.playbackPosition).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 7. close() called twice — must not double-finish or throw.
  // -----------------------------------------------------------------------
  it('double close does not throw or double-finish', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    await output.close();
    await output.close(); // second close — must be safe

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 8. Interleaved: capture, clear, capture, clear, capture, flush.
  //    Three segments total (capture starts a new one each time after clear).
  //    Only the last segment's flush should be non-interrupted.
  // -----------------------------------------------------------------------
  it('interleaved capture/clear/capture/clear/capture/flush resolves correctly', async () => {
    const ws = createFakeWs();
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    // Segment 1 — interrupted
    await output.captureFrame(createFrame());
    output.clearBuffer();

    // Segment 2 — interrupted
    await output.captureFrame(createFrame());
    output.clearBuffer();

    // Segment 3 — completed
    await output.captureFrame(createFrame());
    output.flush();

    await new Promise((r) => setImmediate(r));

    const event = await withTimeout(output.waitForPlayout());
    // Final segment was flushed, not cleared
    expect(event.interrupted).toBe(false);
    expect(event.playbackPosition).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // 9. Many frames queued, then clearBuffer mid-drain.
  //    The drainAsync loop is running via setImmediate. If clearBuffer
  //    empties the queue while drainAsync is mid-flight, it must not
  //    leave the segment unfinished.
  // -----------------------------------------------------------------------
  it('clearBuffer during active drain does not leave segment unfinished', async () => {
    const ws = createFakeWs();
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    // Queue 50 frames — drain will be processing them via setImmediate
    for (let i = 0; i < 50; i++) {
      await output.captureFrame(createFrame());
    }

    // Immediately clear while drain is in-flight
    output.clearBuffer();

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
    // Some frames may have been sent before clearBuffer — that's fine.
    // The critical thing is waitForPlayout resolved.
  });

  // -----------------------------------------------------------------------
  // 10. WS goes from OPEN to CLOSED between captureFrame and drainAsync.
  //     Simulates a client disconnect during audio output.
  // -----------------------------------------------------------------------
  it('WS readyState change to CLOSED mid-segment does not hang', async () => {
    const ws = createFakeWs((data) => {
      // First send succeeds, then WS "closes"
      if (ws.sent.length >= 1) {
        ws.readyState = 3; // CLOSED
        throw new Error('WebSocket is not open');
      }
      ws.sent.push(Buffer.from(data));
    });
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    await output.captureFrame(createFrame());
    await output.captureFrame(createFrame()); // this one will fail on send

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
    expect(ws.sent.length).toBe(1); // only first frame sent
  });

  // -----------------------------------------------------------------------
  // 11. waitForPlayout called BEFORE any activity — should resolve
  //     immediately since segmentsCount == finishedCount == 0.
  // -----------------------------------------------------------------------
  it('waitForPlayout on a brand-new output resolves immediately', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);
    const event = await withTimeout(output.waitForPlayout(), 100);
    expect(event.playbackPosition).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 12. Multiple concurrent waitForPlayout calls on the same segment.
  //     All must resolve, not just the first one.
  // -----------------------------------------------------------------------
  it('multiple concurrent waitForPlayout calls all resolve', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    output.flush();

    const [a, b, c] = await withTimeout(
      Promise.all([
        output.waitForPlayout(),
        output.waitForPlayout(),
        output.waitForPlayout(),
      ]),
    );

    expect(a.interrupted).toBe(false);
    expect(b.interrupted).toBe(false);
    expect(c.interrupted).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 13. Stress test: 100 segments, alternating between flush and clearBuffer
  //     randomly. Counter drift of even 1 across 100 iterations = permanent hang.
  // -----------------------------------------------------------------------
  it('100 segments with random flush/clear never drifts counters', async () => {
    const ws = createFakeWs();
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);
    const rng = (seed: number) => {
      // Simple deterministic PRNG for reproducibility
      let s = seed;
      return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % 2 === 0; };
    };
    const shouldFlush = rng(42);

    for (let i = 0; i < 100; i++) {
      await output.captureFrame(createFrame(240));
      if (shouldFlush()) {
        output.flush();
      } else {
        output.clearBuffer();
      }
      // Yield to let drainAsync process
      if (i % 10 === 0) await new Promise((r) => setImmediate(r));
    }

    // If counters drifted, this hangs forever.
    const event = await withTimeout(output.waitForPlayout(), 2000);
    expect(event).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // 14. captureFrame → close → flush — close should finalize the segment.
  //     The subsequent flush must not re-open or double-count.
  // -----------------------------------------------------------------------
  it('close between captureFrame and flush does not double-count', async () => {
    const output = new WebSocketAudioOutput(createFakeWs() as never, 'test', 24000);

    await output.captureFrame(createFrame());
    await output.close();
    output.flush(); // after close — should be a no-op

    const event = await withTimeout(output.waitForPlayout());
    expect(event.interrupted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 15. Large frame burst then immediate close — exercises the interaction
  //     between drainAsync's setImmediate loop and close() clearing the queue.
  // -----------------------------------------------------------------------
  it('close during burst drain resolves without hanging', async () => {
    const ws = createFakeWs();
    const output = new WebSocketAudioOutput(ws as never, 'test', 24000);

    // Fire 200 frames without yielding — they all queue up
    const frames = Array.from({ length: 200 }, () => createFrame());
    for (const f of frames) {
      await output.captureFrame(f);
    }

    // Close while drain loop is mid-flight
    await output.close();

    const event = await withTimeout(output.waitForPlayout(), 500);
    expect(event.interrupted).toBe(true);
    // Not all 200 frames should have been sent — close clears the queue
    expect(ws.sent.length).toBeLessThan(200);
  });
});
