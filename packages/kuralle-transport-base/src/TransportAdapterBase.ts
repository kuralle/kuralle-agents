import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  TransportAdapter,
  type AudioInput,
  type AudioOutput,
  type TextOutput,
  type TransportAdapterConfig,
} from '@kuralle-agents/livekit-plugin';

/**
 * Events emitted by {@link TransportAdapterBase}.
 *
 * Subclasses emit these via the protected helpers; consumers subscribe
 * through {@link TransportAdapterBase.on}.
 */
export interface TransportAdapterBaseEvents {
  /** Underlying transport error. */
  error: [error: Error];
  /** Transport has closed (idempotent — emitted once). */
  close: [];
}

/**
 * Default base for transport adapters. Provides:
 *
 * - `id` (randomUUID if not supplied)
 * - `isOpen` state tracking
 * - Idempotent `close()` that tears down `audioInput`, `audioOutput`, and
 *   `textOutput`, then emits `'close'`.
 * - A lightweight listener registry (`on` / `off`) over Node's
 *   {@link EventEmitter}.
 * - Protected `emitError` / `emitClose` helpers for subclass use.
 *
 * Subclasses only need to construct the I/O objects + config and may call
 * `emitError(err)` whenever the underlying transport fails. They do not
 * need to reimplement the `_isOpen` / `close()` dance that every transport
 * previously duplicated.
 */
export abstract class TransportAdapterBase extends TransportAdapter {
  readonly id: string;
  abstract readonly audioInput: AudioInput;
  abstract readonly audioOutput: AudioOutput;
  abstract readonly textOutput: TextOutput;
  abstract readonly config: TransportAdapterConfig;

  private _isOpen: boolean = true;
  private _emitter = new EventEmitter();

  constructor(id?: string) {
    super();
    this.id = id ?? randomUUID();
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  on<E extends keyof TransportAdapterBaseEvents>(
    event: E,
    handler: (...args: TransportAdapterBaseEvents[E]) => void,
  ): this {
    this._emitter.on(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof TransportAdapterBaseEvents>(
    event: E,
    handler: (...args: TransportAdapterBaseEvents[E]) => void,
  ): this {
    this._emitter.off(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  once<E extends keyof TransportAdapterBaseEvents>(
    event: E,
    handler: (...args: TransportAdapterBaseEvents[E]) => void,
  ): this {
    this._emitter.once(event as string, handler as (...args: unknown[]) => void);
    return this;
  }

  listenerCount<E extends keyof TransportAdapterBaseEvents>(event: E): number {
    return this._emitter.listenerCount(event as string);
  }

  /**
   * Emit a transport-level error. Safe after close() — swallowed if no
   * listeners are attached (matches Node EventEmitter semantics for
   * non-'error' channels; we intentionally avoid Node's unhandled-error
   * throw behavior so a late error during teardown does not crash the host).
   */
  protected emitError(err: Error): void {
    if (this._emitter.listenerCount('error') === 0) return;
    this._emitter.emit('error', err);
  }

  /**
   * Idempotent close sequence:
   *   1. mark closed,
   *   2. call the subclass hook (onClose) for transport-specific teardown,
   *   3. close each I/O in a try/catch so one failing leg does not skip others,
   *   4. emit `'close'` exactly once.
   */
  async close(): Promise<void> {
    if (!this._isOpen) return;
    this._isOpen = false;

    try {
      await this.onClose();
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }

    for (const io of [
      this.audioInput as { close?: () => Promise<void> | void },
      this.audioOutput as { close?: () => Promise<void> | void },
      this.textOutput as { close?: () => Promise<void> | void },
    ]) {
      if (typeof io.close !== 'function') continue;
      try {
        await io.close();
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this._emitter.emit('close');
    this._emitter.removeAllListeners();
  }

  /**
   * Optional subclass hook — runs before the I/O close sweep. Default
   * implementation is a no-op; override to close a WebSocket, cancel a
   * timer, etc.
   */
  protected async onClose(): Promise<void> {
    // no-op
  }
}
