import type { KuralleVoiceSession, SessionManager } from '@kuralle-agents/livekit-plugin';
import type { AgentHandler } from '../src/handler.js';
import type { HTTPTransportAdapter } from '../src/transport_adapter.js';

export type AgentHandlerTestState = {
  adapters: Map<string, { isOpen?: boolean; touch?: () => void; audioInput?: { pushAudioBuffer: (...args: never[]) => unknown } }>;
  sessionManager: Record<string, unknown>;
};

export function getAgentHandlerTestState(handler: AgentHandler): AgentHandlerTestState {
  // @ts-expect-error — test-only cast to access private fields
  return handler as AgentHandlerTestState;
}

export function stubVoiceSession(): KuralleVoiceSession {
  return {} as KuralleVoiceSession;
}
