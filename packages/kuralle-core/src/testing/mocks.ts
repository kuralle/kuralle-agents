import { createUIMessageStreamResponse } from 'ai';
import { harnessToUIMessageStream } from '../ai-sdk/uiMessageStream.js';
import type { HarnessStreamPart, TurnHandle } from '../types/stream.js';
import type { TurnResult } from '../types/channel.js';
import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { RunOptions } from '../runtime/Runtime.js';
import type { UserInputContent } from '../runtime/userInput.js';
import type { RuntimeLike } from '../runtime/RuntimeLike.js';

export interface MockRuntimeRunCall {
  sessionId?: string;
  input?: UserInputContent;
  agentId?: string;
  seedMessages?: unknown[];
}

export interface CreateMockRuntimeOptions {
  sessions?: Map<string, Session>;
  onRun?: (call: MockRuntimeRunCall) => void;
}

export function createMockTurnHandle(
  events: AsyncIterable<HarnessStreamPart>,
  settled: TurnResult = { text: '', toolResults: [] },
): TurnHandle {
  return Object.assign(Promise.resolve(settled), {
    events,
    toResponseStream: () => new ReadableStream(),
    toUIMessageStreamResponse(opts?: { sessionId?: string }): Response {
      return createUIMessageStreamResponse({
        stream: harnessToUIMessageStream(events, opts),
      });
    },
    cancel: () => {},
  }) as TurnHandle;
}

export function createMockSession(partial: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: partial.id ?? 'sess-test',
    conversationId: partial.conversationId ?? partial.id ?? 'sess-test',
    channelId: partial.channelId ?? 'test',
    userId: partial.userId ?? 'user-test',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
    messages: partial.messages ?? [],
    workingMemory: partial.workingMemory ?? {},
    currentAgent: partial.currentAgent ?? 'main',
    activeAgentId: partial.activeAgentId,
    state: partial.state,
    metadata: partial.metadata ?? {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: partial.agentStates ?? {},
    handoffHistory: partial.handoffHistory ?? [],
  };
}

type MockRuntimeEvents =
  | HarnessStreamPart[]
  | AsyncIterable<HarnessStreamPart>
  | (() => never);

export function createMockRuntime(
  parts: MockRuntimeEvents,
  options: CreateMockRuntimeOptions = {},
): RuntimeLike {
  const sessions = options.sessions ?? new Map<string, Session>();

  const run = (opts: RunOptions): TurnHandle => {
    if (typeof parts === 'function') {
      throw parts();
    }

    options.onRun?.({
      sessionId: opts.sessionId,
      input: opts.input,
      agentId: opts.agentId,
      seedMessages: opts.seedMessages,
    });

    async function* events(): AsyncGenerator<HarnessStreamPart> {
      if (Symbol.asyncIterator in Object(parts)) {
        for await (const part of parts as AsyncIterable<HarnessStreamPart>) {
          yield part;
        }
        return;
      }
      for (const part of parts as HarnessStreamPart[]) {
        yield part;
      }
    }

    return createMockTurnHandle(events());
  };

  const store: SessionStore = {
    get: async (id: string) => sessions.get(id) ?? null,
    save: async (session: Session) => {
      sessions.set(session.id, session);
    },
    delete: async (id: string) => {
      sessions.delete(id);
    },
    list: async (userId?: string) => {
      const all = [...sessions.values()];
      return userId ? all.filter((s) => s.userId === userId) : all;
    },
  };

  return {
    run,
    stream: run,
    getSession: async (id: string) => sessions.get(id) ?? null,
    getSessionStore: () => store,
    deleteSession: async (id: string) => {
      sessions.delete(id);
    },
    abortSession: () => {},
    replayAuditLog: async () => [],
    markOutcome: async () => {},
    getConversationLength: async () => 0,
  };
}
