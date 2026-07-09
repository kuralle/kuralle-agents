import type { InboundEvent } from './types.js';

export type ClaimResult = 'claimed' | 'duplicate' | 'in_progress';

export interface ConversationKey {
  platform: string;
  businessId: string;
  threadId: string;
}

export type ConvKeyStr = string;

export interface InboundLedger {
  claim(key: ConversationKey, eventId: string): Promise<ClaimResult>;
  complete(key: ConversationKey, eventId: string): Promise<void>;
  append(key: ConversationKey, event: InboundEvent): Promise<{ seq: number }>;
  readUnprocessed(key: ConversationKey): Promise<InboundEvent[]>;
  commitCursor(key: ConversationKey, throughSeq: number, expect: number): Promise<boolean>;
  prune(key: ConversationKey, ttlMs: number): Promise<number>;
}

type LedgerStatus = 'in_progress' | 'complete';

type StoredEvent = {
  event: InboundEvent;
  seq: number;
  appendedAt: number;
};

type LedgerState = {
  nextSeq: number;
  cursor: number;
  claims: Map<string, LedgerStatus>;
  events: StoredEvent[];
};

export const ledgerSeq = Symbol.for('@kuralle-agents/messaging/inbound-seq');

export type SequencedInboundEvent = InboundEvent & { [ledgerSeq]?: number };

export function conversationKeyToString(key: ConversationKey): ConvKeyStr {
  return `${key.platform}:${key.businessId}:${key.threadId}`;
}

export function eventSeq(event: InboundEvent): number | undefined {
  return (event as SequencedInboundEvent)[ledgerSeq];
}

export class InMemoryInboundLedger implements InboundLedger {
  private readonly states = new Map<ConvKeyStr, LedgerState>();

  async claim(key: ConversationKey, eventId: string): Promise<ClaimResult> {
    const state = this.state(key);
    const existing = state.claims.get(eventId);
    if (existing === 'complete') return 'duplicate';
    if (existing === 'in_progress') return 'in_progress';
    state.claims.set(eventId, 'in_progress');
    return 'claimed';
  }

  async complete(key: ConversationKey, eventId: string): Promise<void> {
    this.state(key).claims.set(eventId, 'complete');
  }

  async append(key: ConversationKey, event: InboundEvent): Promise<{ seq: number }> {
    const state = this.state(key);
    if (state.events.some((stored) => stored.event.id === event.id)) {
      const stored = state.events.find((item) => item.event.id === event.id)!;
      return { seq: stored.seq };
    }
    const seq = state.nextSeq++;
    const sequenced = Object.assign({}, event) as SequencedInboundEvent;
    Object.defineProperty(sequenced, ledgerSeq, {
      value: seq,
      enumerable: false,
    });
    state.events.push({ event: sequenced, seq, appendedAt: Date.now() });
    state.events.sort((a, b) => a.event.ts - b.event.ts || a.seq - b.seq);
    return { seq };
  }

  async readUnprocessed(key: ConversationKey): Promise<InboundEvent[]> {
    const state = this.state(key);
    return state.events
      .filter((stored) => stored.seq > state.cursor)
      .sort((a, b) => a.event.ts - b.event.ts || a.seq - b.seq)
      .map((stored) => stored.event);
  }

  async commitCursor(
    key: ConversationKey,
    throughSeq: number,
    expect: number,
  ): Promise<boolean> {
    const state = this.state(key);
    if (state.cursor !== expect) return false;
    state.cursor = Math.max(state.cursor, throughSeq);
    return true;
  }

  async prune(key: ConversationKey, ttlMs: number): Promise<number> {
    const state = this.state(key);
    const cutoff = Date.now() - ttlMs;
    const before = state.events.length;
    state.events = state.events.filter(
      (stored) => stored.seq > state.cursor || stored.appendedAt >= cutoff,
    );
    return before - state.events.length;
  }

  cursor(key: ConversationKey): number {
    return this.state(key).cursor;
  }

  private state(key: ConversationKey): LedgerState {
    const str = conversationKeyToString(key);
    let state = this.states.get(str);
    if (!state) {
      state = { nextSeq: 1, cursor: 0, claims: new Map(), events: [] };
      this.states.set(str, state);
    }
    return state;
  }
}

