/**
 * Session-state FSM for the OpenAI Realtime family Cloudflare client.
 *
 * Transitions:
 *
 *   IDLE → CONNECTING (begin connect)
 *   CONNECTING → ACTIVE (after `session.updated`)
 *   CONNECTING → IDLE (cancelled / errored before active)
 *   ACTIVE → CLOSING (begin disconnect)
 *   CLOSING → IDLE (socket teardown complete)
 *
 * Valid `connect()` entry points: IDLE or CLOSING. Any other state means a
 * caller is double-connecting and we throw rather than tangle the socket.
 *
 * The states themselves are stable and need their own type (used by the
 * client's queue-drain gate and several public predicates).
 */

export type SessionState = 'IDLE' | 'CONNECTING' | 'ACTIVE' | 'CLOSING';

export class OpenAIFamilySessionState {
  #state: SessionState = 'IDLE';

  get current(): SessionState {
    return this.#state;
  }

  /** True when the WS is open and `session.updated` has been received. */
  get isActive(): boolean {
    return this.#state === 'ACTIVE';
  }

  /** True when no work should be sent (closing or idle). */
  get isQuiescent(): boolean {
    return this.#state === 'CLOSING' || this.#state === 'IDLE';
  }

  /**
   * Validate the entry point for a fresh `connect()` and transition into
   * CONNECTING. Throws if the FSM is already past the entry gate.
   */
  beginConnect(label: string): void {
    if (this.#state !== 'IDLE' && this.#state !== 'CLOSING') {
      throw new Error(`${label}: connect() while state=${this.#state}`);
    }
    this.#state = 'CONNECTING';
  }

  /** `session.updated` arrived — promote CONNECTING to ACTIVE. */
  markActive(): void {
    this.#state = 'ACTIVE';
  }

  /** Reset to IDLE after a failed connect / disconnect / teardown. */
  reset(): void {
    this.#state = 'IDLE';
  }

  /** Begin a controlled disconnect. */
  beginClose(): void {
    this.#state = 'CLOSING';
  }

  /**
   * Called from the WS teardown helper. Drops ACTIVE → IDLE so a caller can
   * see `connected === false` immediately, but leaves CLOSING intact so the
   * disconnect path can finalize on its own terms.
   */
  onSocketGone(): void {
    if (this.#state === 'ACTIVE') {
      this.#state = 'IDLE';
    }
  }
}
