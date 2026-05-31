/**
 * @module rate-limiter
 *
 * Token-bucket rate limiter with concurrency control.
 *
 * Enforces two constraints simultaneously:
 * 1. **Per-second throughput** — a token bucket that refills at `perSecondLimit` tokens/s.
 * 2. **Concurrent requests** — at most `maxConcurrent` in-flight requests.
 *
 * Consumers may install an optional {@link UsageHeaderParser} that inspects
 * response headers and signals over-quota conditions; when triggered the
 * effective throughput is halved until the next header update clears the flag.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Rate limiter configuration. */
export interface RateLimiterConfig {
  /** Maximum number of concurrent in-flight requests. Default `40`. */
  maxConcurrent: number;
  /** Maximum number of requests per second (token refill rate). Default `80`. */
  perSecondLimit: number;
}

/** Sensible defaults. */
export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxConcurrent: 40,
  perSecondLimit: 80,
};

/**
 * Inspects response headers and returns `true` if the account is approaching
 * its platform quota, signalling the limiter to enter a throttled state.
 */
export type UsageHeaderParser = (headers: Headers) => boolean;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface QueuedRequest {
  resolve: () => void;
}

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

/**
 * Token-bucket rate limiter with concurrency gating.
 *
 * Call {@link acquire} before making a request and {@link release} when the
 * response has been fully consumed.
 */
export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly headerParser?: UsageHeaderParser;

  private concurrent = 0;
  private tokens: number;
  private lastRefill: number;
  private waitQueue: QueuedRequest[] = [];
  private throttled = false;

  constructor(config: Partial<RateLimiterConfig> = {}, headerParser?: UsageHeaderParser) {
    this.config = { ...DEFAULT_RATE_LIMITER_CONFIG, ...config };
    this.tokens = this.config.perSecondLimit;
    this.lastRefill = Date.now();
    this.headerParser = headerParser;
  }

  /**
   * Wait until a request slot is available.
   */
  async acquire(): Promise<void> {
    this.refillTokens();

    const effectiveLimit = this.throttled
      ? Math.ceil(this.config.perSecondLimit / 2)
      : this.config.perSecondLimit;

    if (this.tokens > 0 && this.concurrent < this.config.maxConcurrent) {
      this.tokens = Math.min(this.tokens, effectiveLimit);
      this.tokens--;
      this.concurrent++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push({ resolve });
      setTimeout(() => this.drain(), 1_000 / this.config.perSecondLimit);
    });
  }

  /** Release a concurrency slot after a request completes. */
  release(): void {
    this.concurrent = Math.max(0, this.concurrent - 1);
    this.drain();
  }

  /**
   * Update throttling state from a response's headers.
   *
   * If no {@link UsageHeaderParser} was configured, this is a no-op.
   */
  updateFromHeaders(headers: Headers): void {
    if (!this.headerParser) return;
    try {
      this.throttled = this.headerParser(headers);
    } catch {
      // Malformed headers are not the limiter's problem.
    }
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;

    const tokensToAdd = (elapsedMs / 1_000) * this.config.perSecondLimit;
    this.tokens = Math.min(this.tokens + tokensToAdd, this.config.perSecondLimit);
    this.lastRefill = now;
  }

  private drain(): void {
    this.refillTokens();

    while (
      this.waitQueue.length > 0 &&
      this.tokens > 0 &&
      this.concurrent < this.config.maxConcurrent
    ) {
      this.tokens--;
      this.concurrent++;
      const next = this.waitQueue.shift()!;
      next.resolve();
    }
  }
}
