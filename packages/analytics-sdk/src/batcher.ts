/**
 * In-memory batching with exponential backoff on flush failure.
 *
 * Behavior:
 *   - Buffer events until either maxBatchSize is reached or flushInterval
 *     fires, then call onFlush(events).
 *   - On failure, the batch is re-queued and retried after
 *     `baseDelayMs * 2^(attempt-1)` ms, capped at `maxDelayMs`.
 *   - After `maxAttempts` failures, the batch is dropped and a warning is
 *     logged (once per dropped batch).
 */

import type { AnalyticsEvent } from "./schema.js";
import { debug } from "./debug.js";

export interface BatcherOptions {
  maxBatchSize: number;
  flushInterval: number;
  onFlush: (events: AnalyticsEvent[]) => Promise<void>;
  enableDebug?: boolean;
  /** Test/override hook: clock used by setTimeout. Default: global timers. */
  scheduler?: {
    setTimeout(cb: () => void, ms: number): { unref?: () => void };
    clearTimeout(handle: unknown): void;
  };
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryMaxAttempts?: number;
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;

export class Batcher {
  private queue: AnalyticsEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: unknown = null;

  constructor(private readonly options: BatcherOptions) {
    this.startFlushTimer();
  }

  add(event: AnalyticsEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.options.maxBatchSize) {
      void this.flush();
    }
  }

  /**
   * Send whatever is queued. Successful flush clears the queue; failures are
   * scheduled for retry with exponential backoff (up to `retryMaxAttempts`).
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const events = [...this.queue];
    this.queue = [];
    await this.deliverWithRetry(events, 1);
  }

  private async deliverWithRetry(events: AnalyticsEvent[], attempt: number): Promise<void> {
    if (this.options.enableDebug) {
      debug(`[Analytics] Flushing ${events.length} events (attempt ${attempt})`);
    }
    try {
      await this.options.onFlush(events);
    } catch (error) {
      const maxAttempts = this.options.retryMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (attempt >= maxAttempts) {
        console.error(
          `[Analytics] Dropped batch of ${events.length} events after ${attempt} attempts:`,
          error,
        );
        return;
      }
      const delay = this.computeBackoffDelay(attempt);
      if (this.options.enableDebug) {
        console.warn(`[Analytics] Flush attempt ${attempt} failed; retrying in ${delay}ms`);
      }
      await this.wait(delay);
      await this.deliverWithRetry(events, attempt + 1);
    }
  }

  private computeBackoffDelay(attempt: number): number {
    const base = this.options.retryBaseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const cap = this.options.retryMaxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    return Math.min(cap, base * 2 ** (attempt - 1));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const sched = this.options.scheduler;
      if (sched) {
        this.retryTimer = sched.setTimeout(() => resolve(), ms);
        return;
      }
      this.retryTimer = setTimeout(() => resolve(), ms);
    });
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.options.flushInterval);
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retryTimer) {
      const sched = this.options.scheduler;
      if (sched) sched.clearTimeout(this.retryTimer);
      else clearTimeout(this.retryTimer as ReturnType<typeof setTimeout>);
      this.retryTimer = null;
    }
    void this.flush();
  }
}
