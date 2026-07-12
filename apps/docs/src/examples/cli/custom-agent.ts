import { openai } from '@ai-sdk/openai';
import {
  createRuntime,
  defineAgent,
  MemoryStore,
  type SessionStore,
} from '@kuralle-agents/core';

export interface AgentRuntime {
  runtime: ReturnType<typeof createRuntime>;
  store: SessionStore;
  sessionId: string;
  agentId: string;
  label: string;
  readState: () => Promise<{ roles: string[] }>;
}

// The `--agent <path.ts>` contract: export `buildRuntime(sessionId?, store?)`.
// `kuralle chat` / `send` / `sim` / `trace` all load this instead of the demo agent.
export function buildRuntime(
  sessionId = crypto.randomUUID(),
  store: SessionStore = new MemoryStore(),
): AgentRuntime {
  const agent = defineAgent({
    id: 'support',
    instructions: 'You are a helpful support agent.',
    model: openai('gpt-4o-mini'),
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: 'support',
    sessionStore: store,
  });

  return {
    runtime,
    store,
    sessionId,
    agentId: 'support',
    label: 'Support agent',
    readState: async () => {
      const session = await store.get(sessionId);
      return { roles: (session?.messages ?? []).map((message) => message.role) };
    },
  };
}
