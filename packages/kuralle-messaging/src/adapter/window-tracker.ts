/** Default messaging window duration: 24 hours. */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Stale entry cleanup interval: 1 hour. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

interface WindowEntry {
  /** When the window expires (either computed or from platform status). */
  expiresAt: Date;
}

/**
 * Tracks the 24-hour messaging window for each conversation thread.
 *
 * Many messaging platforms (notably WhatsApp) only allow free-form messages
 * within a window that starts when the user last messaged. After the window
 * closes, only template messages can be sent.
 *
 * The tracker records:
 * - Inbound message timestamps (sets window to `timestamp + 24h`)
 * - Platform-reported expiry times (from status webhooks, more accurate)
 *
 * Stale entries are periodically cleaned up to prevent unbounded memory growth.
 */
export class WindowTracker {
  private readonly windows: Map<string, WindowEntry> = new Map();
  private lastCleanup: number = Date.now();

  /**
   * Record an inbound message, opening or extending the messaging window.
   * The window is set to 24 hours from the message timestamp.
   *
   * @param threadId - The conversation thread identifier.
   * @param timestamp - When the user's message was sent.
   */
  recordInbound(threadId: string, timestamp: Date): void {
    this.maybeCleanup();
    const expiresAt = new Date(timestamp.getTime() + DEFAULT_WINDOW_MS);
    const existing = this.windows.get(threadId);

    // Only extend — never shrink the window
    if (!existing || expiresAt > existing.expiresAt) {
      this.windows.set(threadId, { expiresAt });
    }
  }

  /**
   * Record a platform-reported window expiry (e.g. from a WhatsApp status webhook).
   * Platform-reported values are more accurate than computed ones.
   *
   * @param threadId - The conversation thread identifier.
   * @param expiresAt - The platform-reported expiration timestamp.
   */
  recordExpiry(threadId: string, expiresAt: Date): void {
    this.maybeCleanup();
    this.windows.set(threadId, { expiresAt });
  }

  /**
   * Check whether the messaging window is currently open for a thread.
   *
   * @param threadId - The conversation thread identifier.
   * @returns `true` if the window is open and free-form messages can be sent.
   */
  isWindowOpen(threadId: string): boolean {
    const entry = this.windows.get(threadId);
    if (!entry) return false;
    return entry.expiresAt > new Date();
  }

  /**
   * Get the window expiry timestamp for a thread.
   *
   * @param threadId - The conversation thread identifier.
   * @returns The expiry date, or `null` if no window is tracked.
   */
  getExpiry(threadId: string): Date | null {
    const entry = this.windows.get(threadId);
    return entry?.expiresAt ?? null;
  }

  /**
   * Run cleanup if enough time has passed since the last cleanup.
   * Removes all expired entries to prevent unbounded memory growth.
   */
  private maybeCleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;

    this.lastCleanup = now;
    const cutoff = new Date(now);
    for (const [threadId, entry] of this.windows) {
      if (entry.expiresAt <= cutoff) {
        this.windows.delete(threadId);
      }
    }
  }

  /** Return the number of tracked windows. */
  get size(): number {
    return this.windows.size;
  }

  /** Clear all tracked windows. */
  clear(): void {
    this.windows.clear();
  }
}
