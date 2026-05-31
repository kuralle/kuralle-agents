import { describe, expect, it } from 'bun:test';
import { voice } from '@livekit/agents';
import { AudioInput, AudioOutput, TextOutput } from '../src/livekit_io.js';
import { createAgentSessionForMetrics } from './livekit_stubs.js';

describe('livekit_io internal class extraction (Phase 4)', () => {
  // --- Structural checks: the extracted values are constructors ---

  it('AudioInput is a constructor function', () => {
    expect(typeof AudioInput).toBe('function');
    expect(AudioInput.prototype).toBeDefined();
  });

  it('AudioOutput is a constructor function', () => {
    expect(typeof AudioOutput).toBe('function');
    expect(AudioOutput.prototype).toBeDefined();
  });

  it('TextOutput is a constructor function', () => {
    expect(typeof TextOutput).toBe('function');
    expect(TextOutput.prototype).toBeDefined();
  });

  // --- Prototype chain identity: the exported LiveKit subclasses
  //     actually extend our extracted base classes ---

  it('ParticipantAudioOutput extends extracted AudioOutput', () => {
    // If we extracted the right class, ParticipantAudioOutput.prototype
    // should be an instance of AudioOutput (via prototype chain).
    const instance = Object.create(voice.ParticipantAudioOutput.prototype);
    expect(instance instanceof AudioOutput).toBe(true);
  });

  it('ParalellTextOutput extends extracted TextOutput', () => {
    const instance = Object.create(voice.ParalellTextOutput.prototype);
    expect(instance instanceof TextOutput).toBe(true);
  });

  // --- AgentSession wiring: the session's I/O slots accept instances
  //     of our extracted classes ---

  it('AgentSession input.audio type is compatible with extracted AudioInput', () => {
    // Create a minimal AgentSession to inspect its I/O slot types.
    // We pass a mock LLM to avoid needing a real model.
    const session = createAgentSessionForMetrics();

    // The session's input.audio is initially a ParticipantAudioInputStream
    // or null. Either way, setting it to an AudioInput subclass instance
    // should work without type errors at runtime.
    const originalAudio = session.input.audio;

    // Create a minimal AudioInput subclass instance
    class TestAudioInput extends AudioInput {}
    const testInput = new TestAudioInput();

    // This is the critical test: can we assign our extracted-class
    // instance to the session's input slot without it breaking?
    session.input.audio = testInput;
    expect(session.input.audio).toBe(testInput);

    // Restore
    session.input.audio = originalAudio;
    void testInput.close();
  });

  it('AgentSession output.audio accepts extracted AudioOutput subclass', () => {
    const session = createAgentSessionForMetrics();

    const originalAudio = session.output.audio;

    class TestAudioOutput extends AudioOutput {
      clearBuffer(): void {}
    }
    const testOutput = new TestAudioOutput();

    session.output.audio = testOutput;
    expect(session.output.audio).toBe(testOutput);

    session.output.audio = originalAudio;
  });

  it('AgentSession output.transcription accepts extracted TextOutput subclass', () => {
    const session = createAgentSessionForMetrics();

    const originalTranscription = session.output.transcription;

    class TestTextOutput extends TextOutput {
      async captureText(): Promise<void> {}
      flush(): void {}
    }
    const testOutput = new TestTextOutput();

    session.output.transcription = testOutput;
    expect(session.output.transcription).toBe(testOutput);

    session.output.transcription = originalTranscription;
  });

  // --- Method existence on extracted prototypes ---

  it('AudioOutput prototype has captureFrame and flush', () => {
    expect(typeof AudioOutput.prototype.captureFrame).toBe('function');
    expect(typeof AudioOutput.prototype.flush).toBe('function');
  });

  it('TextOutput prototype has onAttached and onDetached', () => {
    expect(typeof TextOutput.prototype.onAttached).toBe('function');
    expect(typeof TextOutput.prototype.onDetached).toBe('function');
  });
});
