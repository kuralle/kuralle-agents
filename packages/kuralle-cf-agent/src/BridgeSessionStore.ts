import type { Session, SessionStore } from '@kuralle-agents/core';
import { getToolName, isToolUIPart, type TextPart, type ToolCallPart, type UIMessage } from 'ai';
import type { OrchestrationState, SqlExecutor } from './types.js';
import { OrchestrationStore } from './OrchestrationStore.js';

/**
 * Bridge SessionStore that splits concerns between CF and Kuralle.
 *
 * CF owns messages (via AIChatAgent's cf_ai_chat_agent_messages table).
 * Kuralle owns orchestration state (via OrchestrationStore).
 *
 * On get(): reconstructs a Session by combining CF's messages with
 * Kuralle's orchestration state.
 *
 * On save(): extracts orchestration state from the Session and saves
 * it. Does NOT save messages -- CF handles that via persistMessages().
 */
export class BridgeSessionStore implements SessionStore {
  private orchestration: OrchestrationStore;
  private cfMessages: UIMessage[];
  private sessionId: string;
  private defaultAgentId: string;

  constructor(options: {
    sqlExecutor: SqlExecutor;
    cfMessages: UIMessage[];
    sessionId: string;
    defaultAgentId: string;
  }) {
    this.orchestration = new OrchestrationStore(options.sqlExecutor);
    this.cfMessages = options.cfMessages;
    this.sessionId = options.sessionId;
    this.defaultAgentId = options.defaultAgentId;
  }

  /**
   * Reconstruct a Session from CF messages + orchestration state.
   * Keyed by `id`: multiple sessions (calls) per DO get isolated rows.
   */
  async get(id: string): Promise<Session | null> {
    const key = id || this.sessionId;
    const orchState = await this.orchestration.get(key);

    // Convert CF UIMessages to Kuralle ModelMessages
    const messages = convertUIMessagesToModelMessages(this.cfMessages);

    return {
      id: key,
      conversationId: key,
      channelId: 'web',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages,
      currentAgent: orchState?.currentAgent ?? this.defaultAgentId,
      workingMemory: orchState?.workingMemory ?? {},
      agentStates: (orchState?.agentStates ?? {}) as Session['agentStates'],
      handoffHistory: (orchState?.handoffHistory ?? []).map(h => ({
        ...h,
        timestamp: new Date(h.timestamp),
      })),
      state: orchState?.state,
    };
  }

  /**
   * Save only orchestration state. CF handles message persistence.
   */
  async save(session: Session): Promise<void> {
    const state: OrchestrationState = {
      currentAgent: session.currentAgent,
      workingMemory: session.workingMemory,
      agentStates: session.agentStates as Record<string, unknown>,
      handoffHistory: (session.handoffHistory ?? []).map(h => ({
        from: h.from,
        to: h.to,
        reason: h.reason,
        timestamp: h.timestamp instanceof Date
          ? h.timestamp.toISOString()
          : String(h.timestamp),
      })),
      state: session.state,
    };
    await this.orchestration.save(session.id, state);
  }

  async delete(id: string): Promise<void> {
    await this.orchestration.clear(id || this.sessionId);
  }

  async list(): Promise<Session[]> {
    // BridgeSessionStore is scoped to one DO; list() returns the current
    // session's reconstruction rather than all rows in the table.
    const session = await this.get(this.sessionId);
    return session ? [session] : [];
  }

  /** Garbage-collect orchestration rows older than `maxAgeMs`. */
  async cleanup(maxAgeMs: number): Promise<number> {
    return this.orchestration.cleanup(maxAgeMs);
  }
}

/**
 * Convert CF UIMessages (parts-based) to Kuralle ModelMessages (content-based).
 *
 * UIMessage has: { id, role, parts: [{type:'text', text:'...'}, {type:'tool-...'}] }
 * ModelMessage has: { role, content: string | [{type:'text', text:'...'}] }
 */
type AssistantContentPart = TextPart | ToolCallPart;

function convertUIMessagesToModelMessages(messages: UIMessage[]): Session['messages'] {
  const result: Session['messages'] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = msg.parts
        ?.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('') ?? '';

      if (text) {
        result.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      const content: AssistantContentPart[] = [];

      for (const part of msg.parts ?? []) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
        } else if (isToolUIPart(part)) {
          content.push({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: getToolName(part),
            input: 'input' in part ? part.input : undefined,
          });
        }
      }

      if (content.length > 0) {
        result.push({ role: 'assistant', content });
      }
    }
  }

  return result;
}
