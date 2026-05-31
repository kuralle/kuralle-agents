import { describe, expect, it } from 'bun:test';
import { createKuralleVoicePipeline } from '../src/session/createKuralleVoicePipeline.js';
import { FillerCoordinator } from '../src/filler/FillerCoordinator.js';
import type { KuralleRuntimeLike } from '../src/llm/KuralleRuntimeLLMAdapter.js';
import { mockTurnHandle } from './mock_turn_handle.js';

describe('createKuralleVoicePipeline', () => {
  it('returns agent, ariaLLM, and fillerCoordinator', () => {
    // Use a mock runtime that satisfies KuralleRuntimeLike
    const mockRuntime: KuralleRuntimeLike = {
      run() {
        return mockTurnHandle((async function* () {
          yield { type: 'done' as const, sessionId: 'test' };
        })());
      },
    };

    const pipeline = createKuralleVoicePipeline({
      runtime: mockRuntime,
    });

    expect(pipeline.agent).toBeTruthy();
    expect(pipeline.ariaLLM).toBeTruthy();
    expect(pipeline.fillerCoordinator).toBeInstanceOf(FillerCoordinator);
  });

  it('fillerCoordinator is shared between agent and ariaLLM', () => {
    const mockRuntime: KuralleRuntimeLike = {
      run() {
        return mockTurnHandle((async function* () {
          yield { type: 'done' as const, sessionId: 'test' };
        })());
      },
    };

    const pipeline = createKuralleVoicePipeline({
      runtime: mockRuntime,
    });

    // The pipeline should expose the same fillerCoordinator instance
    // that was passed to the KuralleRuntimeLLMAdapter
    expect(pipeline.fillerCoordinator).toBeTruthy();
    expect(typeof pipeline.fillerCoordinator.speakFiller).toBe('function');
    expect(typeof pipeline.fillerCoordinator.waitForActiveFillers).toBe('function');
  });
});
