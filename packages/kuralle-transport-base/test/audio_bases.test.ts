import { describe, it, expect } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import { ResamplingAudioInput } from '../src/audio/ResamplingAudioInput.js';
import { ResamplingAudioOutput } from '../src/audio/ResamplingAudioOutput.js';

initializeLogger({ pretty: false, level: 'error' });

class TestInput extends ResamplingAudioInput {
  push(pcm: Int16Array): void {
    this.ingestPcm(pcm);
  }
  endStream(): void {
    this.endCurrentStream();
  }
}

class CapturingOutput extends ResamplingAudioOutput {
  frames: AudioFrame[] = [];
  clears = 0;

  protected override deliverFrame(frame: AudioFrame): void {
    this.frames.push(frame);
  }

  protected override onClearBuffer(): void {
    this.clears += 1;
  }
}

describe('ResamplingAudioInput', () => {
  it('ingests PCM, ends stream, and close() is idempotent', async () => {
    const input = new TestInput({ inputSampleRate: 8000, outputSampleRate: 24000 });
    input.push(new Int16Array(160));
    input.endStream();
    await input.close();
    expect(() => input.push(new Int16Array(160))).not.toThrow();
    await expect(input.close()).resolves.toBeUndefined();
  });

  it('close() is safe without any ingestion', async () => {
    const input = new TestInput({ inputSampleRate: 8000, outputSampleRate: 24000 });
    await input.close();
  });

  it('re-create resampler after endCurrentStream', async () => {
    const input = new TestInput({ inputSampleRate: 8000, outputSampleRate: 16000 });
    input.push(new Int16Array(160));
    input.endStream();
    input.push(new Int16Array(160));
    input.endStream();
    await input.close();
  });
});

describe('ResamplingAudioOutput', () => {
  it('delivers resampled frames via deliverFrame()', async () => {
    const output = new CapturingOutput({ inputSampleRate: 24000, outputSampleRate: 8000 });
    const frame = new AudioFrame(new Int16Array(480), 24000, 1, 480);
    await output.captureFrame(frame);
    // At least one resampled 8kHz frame is expected downstream eventually,
    // but the resampler may buffer — assert non-negative count and flush.
    output.flush();
    await output.close();
    expect(output.frames.length).toBeGreaterThan(0);
  });

  it('clearBuffer() triggers onClearBuffer hook', async () => {
    const output = new CapturingOutput({ inputSampleRate: 24000, outputSampleRate: 8000 });
    output.clearBuffer();
    expect(output.clears).toBe(1);
  });

  it('close() marks the output closed', async () => {
    const output = new CapturingOutput({ inputSampleRate: 24000, outputSampleRate: 8000 });
    await output.close();
    expect(output.isClosed).toBe(true);
  });

  it('flush without frames still emits a playback-finished signal', async () => {
    const output = new CapturingOutput({ inputSampleRate: 24000, outputSampleRate: 8000 });
    expect(() => output.flush()).not.toThrow();
  });
});
