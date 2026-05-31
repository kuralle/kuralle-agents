import { createRuntime } from '@kuralle-agents/core';
import { voiceAgentToRuntimeAgent, GeminiLiveSession } from '@kuralle-agents/realtime-audio';

/**
 * Start an Kuralle v2 native (Gemini Live) session on a WebSocket transport adapter.
 */
export async function startKuralleNativeSession(wsServer, transport, {
  agent,
  gemini,
  hooks,
  onEvent,
}) {
  const runtime = createRuntime({
    agents: [voiceAgentToRuntimeAgent(agent)],
    defaultAgentId: agent.id,
    voiceMode: true,
    hooks,
  });

  return wsServer.startNativeSession(transport, {
    runtime,
    createModelClient: () =>
      new GeminiLiveSession({
        gemini,
        agent,
        onEvent: onEvent ?? (() => {}),
      }),
  });
}
