import { WindowTracker } from './window-tracker.js';

/** Window state value type (RFC §4.1/§4.9). */
export type WindowState =
  | { open: true; expiresAt: Date }
  | { open: false; expiresAt: Date | null };

/** Pluggable messaging-window store (RFC §4.9 / REQ-18). Fail-closed on a miss. */
export interface WindowStore {
  get(threadId: string): Promise<WindowState>;
  recordInbound(threadId: string, ts: Date): Promise<void>;
  recordExpiry(threadId: string, at: Date): Promise<void>;
}

/** In-memory default; wraps WindowTracker. For single-process/dev (REQ-18 — durable adapter is backlog). */
export class InMemoryWindowStore implements WindowStore {
  private readonly tracker: WindowTracker;
  constructor(tracker?: WindowTracker) {
    this.tracker = tracker ?? new WindowTracker();
  }
  async get(threadId: string): Promise<WindowState> {
    const expiresAt = this.tracker.getExpiry(threadId);
    if (!expiresAt) return { open: false, expiresAt: null };
    return expiresAt > new Date()
      ? { open: true, expiresAt }
      : { open: false, expiresAt };
  }
  async recordInbound(threadId: string, ts: Date): Promise<void> {
    this.tracker.recordInbound(threadId, ts);
  }
  async recordExpiry(threadId: string, at: Date): Promise<void> {
    this.tracker.recordExpiry(threadId, at);
  }
}
