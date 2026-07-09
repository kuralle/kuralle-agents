import { describe, it, expect } from 'bun:test';
import type { AudioInput, AudioOutput, TextOutput } from '@kuralle-agents/livekit-plugin';
import { TransportAdapterBase } from '../src/TransportAdapterBase.js';

class FakeIO {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

class ThrowingIO {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
    throw new Error('boom');
  }
}

class StubAdapter extends TransportAdapterBase {
  readonly fakeAudioInput = new FakeIO();
  readonly fakeAudioOutput = new FakeIO();
  readonly fakeTextOutput = new FakeIO();
  readonly audioInput = this.fakeAudioInput as unknown as AudioInput; // FakeIO test stub; livekit IO are @livekit/agents abstract classes
  readonly audioOutput = this.fakeAudioOutput as unknown as AudioOutput; // FakeIO test stub; livekit IO are @livekit/agents abstract classes
  readonly textOutput = this.fakeTextOutput as unknown as TextOutput; // FakeIO test stub; livekit IO are @livekit/agents abstract classes
  readonly config = {
    sampleRate: 24000,
    numChannels: 1,
    encoding: 'pcm_s16le' as const,
    samplesPerChannel: null,
  };
  onCloseCalls = 0;

  protected override async onClose(): Promise<void> {
    this.onCloseCalls += 1;
  }

  fireError(err: Error): void {
    this.emitError(err);
  }
}

class ThrowingAdapter extends TransportAdapterBase {
  readonly fakeAudioInput = new ThrowingIO();
  readonly fakeAudioOutput = new FakeIO();
  readonly fakeTextOutput = new FakeIO();
  readonly audioInput = this.fakeAudioInput as unknown as AudioInput; // FakeIO test stub; livekit IO are @livekit/agents abstract classes
  readonly audioOutput = this.fakeAudioOutput as unknown as AudioOutput; // FakeIO test stub; livekit IO are @livekit/agents abstract classes
  readonly textOutput = this.fakeTextOutput as unknown as TextOutput; // FakeIO test stub; livekit IO are @livekit/agents abstract classes
  readonly config = {
    sampleRate: 8000,
    numChannels: 1,
    encoding: 'mulaw' as const,
    samplesPerChannel: null,
  };
}

describe('TransportAdapterBase', () => {
  it('generates a random id when none provided', () => {
    const a = new StubAdapter();
    const b = new StubAdapter();
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
  });

  it('uses supplied id verbatim', () => {
    const a = new StubAdapter('fixed-id');
    expect(a.id).toBe('fixed-id');
  });

  it('starts open and flips to closed on close()', async () => {
    const a = new StubAdapter();
    expect(a.isOpen).toBe(true);
    await a.close();
    expect(a.isOpen).toBe(false);
  });

  it('close() is idempotent and emits close exactly once', async () => {
    const a = new StubAdapter();
    let closeCount = 0;
    a.on('close', () => {
      closeCount += 1;
    });
    await a.close();
    await a.close();
    await a.close();
    expect(closeCount).toBe(1);
    expect(a.onCloseCalls).toBe(1);
  });

  it('close() tears down audioInput, audioOutput, textOutput in order', async () => {
    const a = new StubAdapter();
    await a.close();
    expect(a.fakeAudioInput.closed).toBe(true);
    expect(a.fakeAudioOutput.closed).toBe(true);
    expect(a.fakeTextOutput.closed).toBe(true);
  });

  it('swallows I/O close errors and surfaces them via the error event', async () => {
    const a = new ThrowingAdapter();
    const errors: Error[] = [];
    a.on('error', (err) => errors.push(err));
    await a.close();
    expect(a.isOpen).toBe(false);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toBe('boom');
    // Other IOs still closed despite earlier throw.
    expect(a.fakeAudioOutput.closed).toBe(true);
    expect(a.fakeTextOutput.closed).toBe(true);
  });

  it('emitError() with no listeners does not throw', () => {
    const a = new StubAdapter();
    expect(() => a.fireError(new Error('unheard'))).not.toThrow();
  });

  it('emitError() dispatches to registered listeners', () => {
    const a = new StubAdapter();
    const errs: Error[] = [];
    a.on('error', (e) => errs.push(e));
    a.fireError(new Error('first'));
    a.fireError(new Error('second'));
    expect(errs.map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('off() removes a previously registered listener', () => {
    const a = new StubAdapter();
    const errs: Error[] = [];
    const handler = (e: Error) => errs.push(e);
    a.on('error', handler);
    a.fireError(new Error('one'));
    a.off('error', handler);
    a.fireError(new Error('two'));
    expect(errs.map((e) => e.message)).toEqual(['one']);
  });

  it('once() fires at most once', () => {
    const a = new StubAdapter();
    let hits = 0;
    a.once('error', () => {
      hits += 1;
    });
    a.fireError(new Error('x'));
    a.fireError(new Error('y'));
    expect(hits).toBe(1);
  });

  it('listenerCount() reports attached count', () => {
    const a = new StubAdapter();
    expect(a.listenerCount('close')).toBe(0);
    a.on('close', () => {});
    a.on('close', () => {});
    expect(a.listenerCount('close')).toBe(2);
  });
});
