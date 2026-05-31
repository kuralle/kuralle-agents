import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { KuralleVoiceSession } from '../src/session/KuralleVoiceSession.js';
import type { KuralleRuntimeLike } from '../src/llm/KuralleRuntimeLLMAdapter.js';
import { mockTurnHandle } from './mock_turn_handle.js';
import { createStubSTT, createStubTTS, createTestTransportAdapter } from './livekit_stubs.js';

initializeLogger({ pretty: false, level: 'warn' });

describe('KuralleVoiceSession runtime identity binding', () => {
  it('binds Aria runtime session context to transport id before session start', async () => {
    const runtime: KuralleRuntimeLike = {
      run() {
        return mockTurnHandle((async function* () {
          yield { type: 'text-delta', text: 'ok' };
          yield { type: 'done', sessionId: 's' };
        })());
      },
    };

    const voiceSession = new KuralleVoiceSession({
      runtime,
      stt: createStubSTT(),
      tts: createStubTTS(),
      greeting: null,
    });

    let seenSessionId: string | undefined;
    const originalSetSessionContext = voiceSession.ariaLLM.setSessionContext.bind(voiceSession.ariaLLM);
    voiceSession.ariaLLM.setSessionContext = (args: { sessionId?: string }) => {
      seenSessionId = args.sessionId;
      originalSetSessionContext(args);
    };

    const transport = createTestTransportAdapter({ id: 'transport-call-001' });

    let failed = false;
    try {
      await voiceSession.start(transport);
    } catch {
      // This test intentionally uses stub STT/TTS and only validates session binding.
      failed = true;
    }

    if (!failed) {
      await voiceSession.close();
    }

    expect(seenSessionId).toBe('transport-call-001');
  });
});
