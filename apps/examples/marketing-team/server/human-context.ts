import type { RunState, ToolContext } from '@kuralle-agents/core';

/**
 * The browser saves through the same tool functions an agent turn would call (`update_content`,
 * `save_brand_context`, `set_content_status`, the asset tools) — "one write path, not two" —
 * but a browser save has no live run to hang a real `ToolContext` off. This builds a minimal,
 * type-honest stand-in: `session.currentAgent` is `'human'`, so the revision/audit columns
 * these tools write (`edited_by_agent`, `created_by_agent`) read as a person's edit rather than
 * inventing an agent name. Mirrors `test/tools/helpers.ts#makeCtx`, which exists for the same
 * reason on the test side.
 */
export function makeHumanToolContext(): ToolContext {
  const now = new Date();
  const session: ToolContext['session'] = {
    id: `web-${crypto.randomUUID()}`,
    conversationId: `web-${crypto.randomUUID()}`,
    channelId: 'web',
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'human',
    agentStates: {},
    handoffHistory: [],
  };
  const runState: RunState = {
    runId: `web-${crypto.randomUUID()}`,
    sessionId: session.id,
    status: 'running',
    activeAgentId: session.currentAgent,
    state: {},
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    session,
    runState,
    emit: () => {},
    tool: async () => {
      throw new Error('ctx.tool is not available outside a run.');
    },
    now: async () => Date.now(),
    uuid: async () => crypto.randomUUID(),
    getSkill: () => {
      throw new Error('getSkill is not available outside a run.');
    },
  };
}
