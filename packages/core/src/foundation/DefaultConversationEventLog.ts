import crypto from 'node:crypto';
import type { StreamPart, RunContext, Session } from '../types/index.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { ConversationEventLog } from './ConversationEventLog.js';
import { isRecord } from '../utils/isRecord.js';

/** Working memory key for the runtime event log array. */
const EVENT_LOG_KEY = 'runtimeEventLog';
/** Working memory key for accumulated assistant text between flushes. */
const ASSISTANT_TEXT_KEY = '__ariaAssistantText';
/** Working memory key for turn tracking. */
const SESSION_TURN_KEY = '__ariaSessionTurn';
/** Max event entries before oldest are evicted. */
const MAX_ENTRIES = 2000;

/** Stream part types that trigger a checkpoint save. */
const CHECKPOINT_TYPES = new Set<StreamPart['type']>([
  'tool-result',
  'flow-transition',
]);

export interface DefaultConversationEventLogConfig {
  sessionStore: SessionStore;
}

/**
 * Default conversation event log extracted from SessionEventManager + Runtime checkpoint logic.
 *
 * Handles:
 * - Recording stream parts into session working memory
 * - Text-delta accumulation and flush on terminal events
 * - Value truncation at depth 5 for safe serialization
 * - Checkpoint determination and persistence
 */
export class DefaultConversationEventLog implements ConversationEventLog {
  private sessionStore: SessionStore;

  constructor(config: DefaultConversationEventLogConfig) {
    this.sessionStore = config.sessionStore;
  }

  record(context: RunContext, part: StreamPart): void {
    // Fast path: text-delta only accumulates text — no UUID, no base object
    if (part.type === 'text-delta') {
      const prevRaw = context.session.workingMemory[ASSISTANT_TEXT_KEY];
      const prev = typeof prevRaw === 'string' ? prevRaw : '';
      context.session.workingMemory[ASSISTANT_TEXT_KEY] = prev + part.payload.delta;
      return;
    }

    const base = {
      id: crypto.randomUUID(),
      sessionId: context.session.id,
      agentId: context.agentId,
      turn: this.getSessionTurn(context.session),
      timestamp: new Date().toISOString(),
    };

    switch (part.type) {
      case 'tool-call':
        this.appendEvent(context, {
          ...base,
          type: 'tool_call',
          toolCallId: part.payload.toolCallId,
          toolName: part.payload.toolName,
          args: this.toEventLogValue(part.payload.args),
        });
        return;
      case 'tool-result':
        this.appendEvent(context, {
          ...base,
          type: 'tool_result',
          toolCallId: part.payload.toolCallId,
          toolName: part.payload.toolName,
          result: this.toEventLogValue(part.payload.result),
        });
        return;
      case 'flow-transition':
        this.appendEvent(context, {
          ...base,
          type: 'transition',
          kind: 'flow',
          from: part.payload.from,
          to: part.payload.to,
        });
        return;
      case 'handoff':
        this.appendEvent(context, {
          ...base,
          type: 'transition',
          kind: 'handoff',
          from: context.agentId,
          to: part.payload.targetAgent,
          reason: part.payload.reason,
        });
        return;
      case 'turn-end':
        this.flushAssistantText(context, 'turn-end');
        return;
      case 'done':
        this.flushAssistantText(context, 'done');
        return;
      case 'error':
        this.flushAssistantText(context, 'error');
        return;
      default:
        return;
    }
  }

  async checkpoint(session: Session): Promise<void> {
    const now = new Date();
    session.updatedAt = now;
    if (session.metadata) {
      session.metadata.lastActiveAt = now;
    }
    // Strip non-serializable pending extraction promises before save —
    // they can't survive JSON.stringify (Redis/Postgres) or structuredClone (cache).
    const pending = session.__pendingExtractions;
    delete session.__pendingExtractions;
    await this.sessionStore.save(session);
    // Restore so in-process turn tracking continues
    if (pending?.length) {
      session.__pendingExtractions = pending;
    }
  }

  shouldCheckpoint(part: StreamPart): boolean {
    return CHECKPOINT_TYPES.has(part.type);
  }

  cleanup(session: Session): void {
    delete session.workingMemory[ASSISTANT_TEXT_KEY];
  }

  // --- Private helpers (extracted from SessionEventManager) ---

  private getSessionTurn(session: Session): number {
    const value = session.workingMemory[SESSION_TURN_KEY];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  private appendEvent(context: RunContext, entry: Record<string, unknown>): void {
    const current = context.session.workingMemory[EVENT_LOG_KEY];
    let events: unknown[];
    if (Array.isArray(current)) {
      events = current;
    } else {
      events = [];
      context.session.workingMemory[EVENT_LOG_KEY] = events;
    }
    events.push(entry);
    if (events.length > MAX_ENTRIES) {
      events.splice(0, events.length - MAX_ENTRIES);
    }
    // Touch session
    const now = new Date();
    context.session.updatedAt = now;
    if (context.session.metadata) {
      context.session.metadata.lastActiveAt = now;
    }
  }

  private flushAssistantText(context: RunContext, trigger: 'turn-end' | 'done' | 'error'): void {
    const textRaw = context.session.workingMemory[ASSISTANT_TEXT_KEY];
    const text = (typeof textRaw === 'string' ? textRaw : '').trim();
    if (text.length > 0) {
      this.appendEvent(context, {
        id: crypto.randomUUID(),
        sessionId: context.session.id,
        agentId: context.agentId,
        turn: this.getSessionTurn(context.session),
        type: 'assistant_final',
        trigger,
        text,
        timestamp: new Date().toISOString(),
      });
    }
    delete context.session.workingMemory[ASSISTANT_TEXT_KEY];
  }

  private toEventLogValue(value: unknown, depth: number = 0): unknown {
    if (value === null || value === undefined) {
      return value;
    }
    if (depth >= 5) {
      return '[truncated]';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    if (Array.isArray(value)) {
      return value.slice(0, 50).map(item => this.toEventLogValue(item, depth + 1));
    }
    if (typeof value === 'function') {
      return '[function]';
    }
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value).slice(0, 50)) {
        out[k] = this.toEventLogValue(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}
