import type {
  HarnessStreamPart,
  RuntimeLike,
} from '@kuralle-agents/core';
import { mergeUserInputContents } from '@kuralle-agents/core';
import {
  conversationKeyToString,
  eventSeq,
  noopCoalesceScheduler,
  systemClock,
  type ClaimResult,
  type Clock,
  type CoalesceScheduler,
  type ConsentStore,
  type ConversationKey,
  type InboundEvent,
  type InboundLedger,
  type InboundRuntime,
  type MediaResolver,
  type OutboundSender,
  type OwnershipStore,
  type SequencedInboundEvent,
  type TurnResult,
  type TurnRunner,
  type WindowState,
  type WindowStore,
} from '@kuralle-agents/messaging';
import { TurnQueue, type MessageConcurrency } from 'agents/chat';
import type { SqlExecutor } from './types.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type SqlRows<T> = T[];

const ledgerSeq = Symbol.for('@kuralle-agents/messaging/inbound-seq');

function nowIso(): string {
  return new Date().toISOString();
}

function claimStatus(value: unknown): 'in_progress' | 'complete' | undefined {
  return value === 'in_progress' || value === 'complete' ? value : undefined;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function encodeEvent(event: InboundEvent): string {
  return JSON.stringify(event);
}

function decodeEvent(row: { event_json: string; seq: number }): InboundEvent {
  const event = JSON.parse(row.event_json) as InboundEvent;
  if (event.kind === 'message') {
    event.data.timestamp = new Date(event.data.timestamp);
  } else if (event.kind === 'status') {
    event.data.timestamp = new Date(event.data.timestamp);
    if (event.data.conversation?.expirationTimestamp) {
      event.data.conversation.expirationTimestamp = new Date(event.data.conversation.expirationTimestamp);
    }
  }
  const sequenced = Object.assign({}, event) as SequencedInboundEvent;
  Object.defineProperty(sequenced, ledgerSeq, {
    value: row.seq,
    enumerable: false,
  });
  return sequenced;
}

function defaultSessionId(key: ConversationKey): string {
  return conversationKeyToString(key);
}

async function collectParts(stream: AsyncIterable<HarnessStreamPart>): Promise<HarnessStreamPart[]> {
  const parts: HarnessStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function turnResult(parts: HarnessStreamPart[]): TurnResult {
  const paused = parts.find(
    (part): part is Extract<HarnessStreamPart, { type: 'paused' }> => part.type === 'paused',
  );
  return {
    parts,
    suspended: paused ? { signalId: paused.waitingFor } : undefined,
    handoffToHuman: parts.some((part) => part.type === 'handoff' && part.targetAgent === 'human'),
  };
}

export class SqlInboundLedger implements InboundLedger {
  private initialized = false;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly options: { inProgressTtlMs?: number } = {},
  ) {}

  async claim(key: ConversationKey, eventId: string): Promise<ClaimResult> {
    this.ensureTables();
    const convKey = conversationKeyToString(key);
    const claimedAt = Date.now();
    this.sql`
      INSERT OR IGNORE INTO kuralle_inbound_claims
        (conv_key, event_id, status, claimed_at)
      VALUES
        (${convKey}, ${eventId}, ${'in_progress'}, ${claimedAt})
    `;
    const inserted = this.sql<{ changed: number }>`SELECT changes() AS changed`;
    if (toNumber(inserted[0]?.changed) > 0) return 'claimed';
    const rows = this.sql<{ status: string; claimed_at: number }>`
      SELECT status, claimed_at FROM kuralle_inbound_claims
      WHERE conv_key = ${convKey} AND event_id = ${eventId}
    `;
    const status = claimStatus(rows[0]?.status);
    if (status === 'complete') return 'duplicate';
    const staleAfterMs = this.options.inProgressTtlMs;
    if (
      status === 'in_progress' &&
      staleAfterMs !== undefined &&
      claimedAt - toNumber(rows[0]?.claimed_at) >= staleAfterMs
    ) {
      this.sql`
        UPDATE kuralle_inbound_claims
        SET claimed_at = ${claimedAt}
        WHERE conv_key = ${convKey} AND event_id = ${eventId}
      `;
      return 'claimed';
    }
    return status === 'in_progress' ? 'in_progress' : 'claimed';
  }

  async complete(key: ConversationKey, eventId: string): Promise<void> {
    this.ensureTables();
    const convKey = conversationKeyToString(key);
    this.sql`
      UPDATE kuralle_inbound_claims
      SET status = ${'complete'}, completed_at = ${Date.now()}
      WHERE conv_key = ${convKey} AND event_id = ${eventId}
    `;
  }

  async append(key: ConversationKey, event: InboundEvent): Promise<{ seq: number }> {
    this.ensureTables();
    const convKey = conversationKeyToString(key);
    this.sql`
      INSERT OR IGNORE INTO kuralle_inbound_events
        (conv_key, event_id, ts, event_json, appended_at)
      VALUES
        (${convKey}, ${event.id}, ${event.ts}, ${encodeEvent(event)}, ${Date.now()})
    `;
    const rows = this.sql<{ seq: number }>`
      SELECT seq FROM kuralle_inbound_events
      WHERE conv_key = ${convKey} AND event_id = ${event.id}
    `;
    return { seq: toNumber(rows[0]?.seq) };
  }

  async readUnprocessed(key: ConversationKey): Promise<InboundEvent[]> {
    this.ensureTables();
    const convKey = conversationKeyToString(key);
    this.ensureCursor(convKey);
    const rows = this.sql<{ seq: number; event_json: string }>`
      SELECT e.seq, e.event_json
      FROM kuralle_inbound_events e
      JOIN kuralle_inbound_cursors c ON c.conv_key = e.conv_key
      WHERE e.conv_key = ${convKey} AND e.seq > c.cursor
      ORDER BY e.ts ASC, e.seq ASC
    `;
    return rows.map((row) => decodeEvent({ event_json: row.event_json, seq: toNumber(row.seq) }));
  }

  async commitCursor(
    key: ConversationKey,
    throughSeq: number,
    expect: number,
  ): Promise<boolean> {
    this.ensureTables();
    const convKey = conversationKeyToString(key);
    this.ensureCursor(convKey);
    this.sql`
      UPDATE kuralle_inbound_cursors
      SET cursor = ${Math.max(throughSeq, expect)}, updated_at = ${Date.now()}
      WHERE conv_key = ${convKey} AND cursor = ${expect}
    `;
    const rows = this.sql<{ changed: number }>`SELECT changes() AS changed`;
    return toNumber(rows[0]?.changed) > 0;
  }

  async prune(key: ConversationKey, ttlMs: number): Promise<number> {
    this.ensureTables();
    const convKey = conversationKeyToString(key);
    this.ensureCursor(convKey);
    const cutoff = Date.now() - ttlMs;
    this.sql`
      DELETE FROM kuralle_inbound_events
      WHERE conv_key = ${convKey}
        AND appended_at < ${cutoff}
        AND seq <= (SELECT cursor FROM kuralle_inbound_cursors WHERE conv_key = ${convKey})
    `;
    const rows = this.sql<{ changed: number }>`SELECT changes() AS changed`;
    return toNumber(rows[0]?.changed);
  }

  cursor(key: ConversationKey): number {
    this.ensureTables();
    const convKey = conversationKeyToString(key);
    this.ensureCursor(convKey);
    const rows = this.sql<{ cursor: number }>`
      SELECT cursor FROM kuralle_inbound_cursors WHERE conv_key = ${convKey}
    `;
    return toNumber(rows[0]?.cursor);
  }

  private ensureTables(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_inbound_claims (
        conv_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('in_progress', 'complete')),
        claimed_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (conv_key, event_id)
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_inbound_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        conv_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        appended_at INTEGER NOT NULL,
        UNIQUE (conv_key, event_id)
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_kuralle_inbound_events_read
      ON kuralle_inbound_events (conv_key, ts, seq)
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_inbound_cursors (
        conv_key TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `;
    this.initialized = true;
  }

  private ensureCursor(convKey: string): void {
    this.sql`
      INSERT OR IGNORE INTO kuralle_inbound_cursors (conv_key, cursor, updated_at)
      VALUES (${convKey}, ${0}, ${Date.now()})
    `;
  }
}

export class SqlWindowStore implements WindowStore {
  private initialized = false;

  constructor(private readonly sql: SqlExecutor) {}

  async get(threadId: string): Promise<WindowState> {
    this.ensureTable();
    const rows = this.sql<{ expires_at: string | null }>`
      SELECT expires_at FROM kuralle_inbound_windows WHERE thread_id = ${threadId}
    `;
    const expiresAt = rows[0]?.expires_at ? new Date(rows[0].expires_at) : null;
    if (!expiresAt) return { open: false, expiresAt: null };
    return expiresAt > new Date() ? { open: true, expiresAt } : { open: false, expiresAt };
  }

  async recordInbound(threadId: string, ts: Date): Promise<void> {
    const expiresAt = new Date(ts.getTime() + 24 * 60 * 60 * 1000);
    await this.recordExpiry(threadId, expiresAt);
  }

  async recordExpiry(threadId: string, at: Date): Promise<void> {
    this.ensureTable();
    this.sql`
      INSERT INTO kuralle_inbound_windows (thread_id, expires_at, updated_at)
      VALUES (${threadId}, ${at.toISOString()}, ${nowIso()})
      ON CONFLICT(thread_id) DO UPDATE SET
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_inbound_windows (
        thread_id TEXT PRIMARY KEY,
        expires_at TEXT,
        updated_at TEXT NOT NULL
      )
    `;
    this.initialized = true;
  }
}

export class SqlConsentStore implements ConsentStore {
  private initialized = false;

  constructor(private readonly sql: SqlExecutor) {}

  async isOptedIn(customerId: string): Promise<boolean> {
    this.ensureTable();
    const rows = this.sql<{ opted_in: number }>`
      SELECT opted_in FROM kuralle_inbound_consent WHERE customer_id = ${customerId}
    `;
    return rows.length === 0 || toNumber(rows[0].opted_in) === 1;
  }

  async optOut(customerId: string): Promise<void> {
    this.ensureTable();
    this.upsert(customerId, false);
  }

  async optIn(customerId: string): Promise<void> {
    this.ensureTable();
    this.upsert(customerId, true);
  }

  private upsert(customerId: string, optedIn: boolean): void {
    this.sql`
      INSERT INTO kuralle_inbound_consent (customer_id, opted_in, updated_at)
      VALUES (${customerId}, ${optedIn ? 1 : 0}, ${nowIso()})
      ON CONFLICT(customer_id) DO UPDATE SET
        opted_in = excluded.opted_in,
        updated_at = excluded.updated_at
    `;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_inbound_consent (
        customer_id TEXT PRIMARY KEY,
        opted_in INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.initialized = true;
  }
}

export class SqlOwnershipStore implements OwnershipStore {
  private initialized = false;

  constructor(private readonly sql: SqlExecutor) {}

  async owner(threadId: string): Promise<'bot' | 'human'> {
    this.ensureTable();
    const rows = this.sql<{ owner: string }>`
      SELECT owner FROM kuralle_inbound_ownership WHERE thread_id = ${threadId}
    `;
    return rows[0]?.owner === 'human' ? 'human' : 'bot';
  }

  async claim(threadId: string, by: string): Promise<void> {
    this.ensureTable();
    const owner = by === 'human' ? 'human' : 'bot';
    this.sql`
      INSERT INTO kuralle_inbound_ownership (thread_id, owner, updated_at)
      VALUES (${threadId}, ${owner}, ${nowIso()})
      ON CONFLICT(thread_id) DO UPDATE SET
        owner = excluded.owner,
        updated_at = excluded.updated_at
    `;
  }

  async release(threadId: string): Promise<void> {
    this.ensureTable();
    this.sql`DELETE FROM kuralle_inbound_ownership WHERE thread_id = ${threadId}`;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_inbound_ownership (
        thread_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL CHECK(owner IN ('bot', 'human')),
        updated_at TEXT NOT NULL
      )
    `;
    this.initialized = true;
  }
}

export interface ScheduleHost {
  schedule<T = JsonValue>(
    when: Date | string | number,
    callback: string,
    payload?: T,
    options?: { idempotent?: boolean },
  ): Promise<{ id: string }>;
  cancelSchedule(id: string): Promise<void>;
}

export class AgentScheduleCoalesceScheduler implements CoalesceScheduler {
  private initialized = false;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly host: ScheduleHost,
    private readonly callback: string,
  ) {}

  async arm(key: ConversationKey, atMs: number): Promise<void> {
    this.ensureTable();
    const convKey = conversationKeyToString(key);
    const existing = this.sql<{ schedule_id: string }>`
      SELECT schedule_id FROM kuralle_inbound_schedule_refs WHERE conv_key = ${convKey}
    `;
    if (existing[0]?.schedule_id) {
      await this.host.cancelSchedule(existing[0].schedule_id);
    }
    const schedule = await this.host.schedule(new Date(atMs), this.callback, { key }, { idempotent: true });
    this.sql`
      INSERT INTO kuralle_inbound_schedule_refs (conv_key, schedule_id, updated_at)
      VALUES (${convKey}, ${schedule.id}, ${Date.now()})
      ON CONFLICT(conv_key) DO UPDATE SET
        schedule_id = excluded.schedule_id,
        updated_at = excluded.updated_at
    `;
  }

  async cancel(key: ConversationKey): Promise<void> {
    this.ensureTable();
    const convKey = conversationKeyToString(key);
    const existing = this.sql<{ schedule_id: string }>`
      SELECT schedule_id FROM kuralle_inbound_schedule_refs WHERE conv_key = ${convKey}
    `;
    if (existing[0]?.schedule_id) {
      await this.host.cancelSchedule(existing[0].schedule_id);
    }
    this.sql`DELETE FROM kuralle_inbound_schedule_refs WHERE conv_key = ${convKey}`;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_inbound_schedule_refs (
        conv_key TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;
    this.initialized = true;
  }
}

export class RuntimeTurnRunner implements TurnRunner {
  constructor(private readonly runtime: RuntimeLike) {}

  async runTurn(args: Parameters<TurnRunner['runTurn']>[0]): Promise<TurnResult> {
    const handle = this.runtime.run({
      input: args.input,
      selection: args.selection,
      sessionId: args.sessionId ?? defaultSessionId(args.key),
      userId: args.userId,
      abortSignal: args.signal,
    });
    return turnResult(await collectParts(handle.events));
  }

  async deliverSignal(args: Parameters<TurnRunner['deliverSignal']>[0]): Promise<TurnResult> {
    const handle = this.runtime.run({
      sessionId: args.sessionId ?? defaultSessionId(args.key),
      signalDelivery: args.signal,
      abortSignal: args.signal2,
    });
    return turnResult(await collectParts(handle.events));
  }
}

export class QueuedTurnRunner implements TurnRunner {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingDebounced: Array<{
    args: Parameters<TurnRunner['runTurn']>[0];
    resolve: (result: TurnResult) => void;
    reject: (reason: unknown) => void;
  }> = [];

  constructor(
    private readonly inner: TurnRunner,
    private readonly queue = new TurnQueue(),
    private readonly messageConcurrency: MessageConcurrency = 'queue',
  ) {}

  async runTurn(args: Parameters<TurnRunner['runTurn']>[0]): Promise<TurnResult> {
    if (typeof this.messageConcurrency === 'object' && this.messageConcurrency.strategy === 'debounce') {
      return this.runDebounced(args, this.messageConcurrency.debounceMs ?? 750);
    }
    const result = await this.queue.enqueue(
      `${conversationKeyToString(args.key)}:${crypto.randomUUID()}`,
      async () => this.inner.runTurn(args),
    );
    return result.status === 'completed' ? result.value : { parts: [] };
  }

  async deliverSignal(args: Parameters<TurnRunner['deliverSignal']>[0]): Promise<TurnResult> {
    const result = await this.queue.enqueue(
      `${conversationKeyToString(args.key)}:${args.signal.signalId}`,
      async () => this.inner.deliverSignal(args),
    );
    return result.status === 'completed' ? result.value : { parts: [] };
  }

  concurrency(): MessageConcurrency {
    return this.messageConcurrency;
  }

  waitForIdle(): Promise<void> {
    return this.queue.waitForIdle();
  }

  private runDebounced(
    args: Parameters<TurnRunner['runTurn']>[0],
    debounceMs: number,
  ): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      this.pendingDebounced.push({ args, resolve, reject });
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = undefined;
        void this.flushDebounced();
      }, debounceMs);
    });
  }

  private async flushDebounced(): Promise<void> {
    const pending = this.pendingDebounced.splice(0);
    if (pending.length === 0) return;
    const latest = pending[pending.length - 1]!;
    const input = mergeUserInputContents(pending.map((item) => item.args.input)) ?? latest.args.input;
    for (const item of pending.slice(0, -1)) item.resolve({ parts: [] });
    try {
      const result = await this.queue.enqueue(
        `${conversationKeyToString(latest.args.key)}:${crypto.randomUUID()}`,
        async () => this.inner.runTurn({ ...latest.args, input }),
      );
      latest.resolve(result.status === 'completed' ? result.value : { parts: [] });
    } catch (error) {
      latest.reject(error);
    }
  }
}

export interface DurableObjectInboundRuntimeOptions {
  sql: SqlExecutor;
  runtime: RuntimeLike;
  media: MediaResolver;
  sender: OutboundSender;
  queue?: TurnQueue;
  messageConcurrency?: MessageConcurrency;
  scheduler?: CoalesceScheduler;
  clock?: Clock;
  window?: WindowStore;
  consent?: ConsentStore;
  ownership?: OwnershipStore;
}

export function createDurableObjectInboundRuntime(
  options: DurableObjectInboundRuntimeOptions,
): InboundRuntime {
  const baseRunner = new RuntimeTurnRunner(options.runtime);
  return {
    ledger: new SqlInboundLedger(options.sql),
    window: options.window ?? new SqlWindowStore(options.sql),
    consent: options.consent ?? new SqlConsentStore(options.sql),
    ownership: options.ownership ?? new SqlOwnershipStore(options.sql),
    media: options.media,
    sender: options.sender,
    runtime: new QueuedTurnRunner(baseRunner, options.queue, options.messageConcurrency),
    scheduler: options.scheduler ?? noopCoalesceScheduler,
    clock: options.clock ?? systemClock,
  };
}

export function eventSeqFromSql(event: InboundEvent): number | undefined {
  return eventSeq(event);
}
