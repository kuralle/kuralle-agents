/**
 * Bounded outbound message queue for the OpenAI Realtime family Cloudflare
 * client. Holds wire-ready JSON strings while the WebSocket is unavailable
 * (between `connect()` entry and `session.updated`, or during a transient
 * teardown).
 *
 * Backpressure: drops from the front (oldest first) when either the event
 * count or byte budget would be exceeded by an enqueue. This matches the
 * LiveKit `messageChannel` behavior the parent module references.
 */

export interface MessageQueueLimits {
  maxEvents: number;
  maxBytes: number;
}

export const DEFAULT_QUEUE_MAX_EVENTS = 256;
export const DEFAULT_QUEUE_MAX_BYTES = 1_048_576; // 1 MiB

export class OpenAIFamilyMessageQueue {
  #items: string[] = [];
  #bytes = 0;
  readonly #limits: MessageQueueLimits;

  constructor(limits: Partial<MessageQueueLimits> = {}) {
    this.#limits = {
      maxEvents: limits.maxEvents ?? DEFAULT_QUEUE_MAX_EVENTS,
      maxBytes: limits.maxBytes ?? DEFAULT_QUEUE_MAX_BYTES,
    };
  }

  get size(): number {
    return this.#items.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Append `serialized` to the queue, dropping from the front to honor the
   * configured event-count and byte budget.
   */
  push(serialized: string): void {
    while (
      (this.#items.length >= this.#limits.maxEvents ||
        this.#bytes + serialized.length > this.#limits.maxBytes) &&
      this.#items.length > 0
    ) {
      const dropped = this.#items.shift()!;
      this.#bytes -= dropped.length;
    }
    this.#items.push(serialized);
    this.#bytes += serialized.length;
  }

  /**
   * Atomically take all queued items in FIFO order, leaving the queue empty.
   */
  drain(): string[] {
    const out = this.#items;
    this.#items = [];
    this.#bytes = 0;
    return out;
  }

  clear(): void {
    this.#items = [];
    this.#bytes = 0;
  }
}
