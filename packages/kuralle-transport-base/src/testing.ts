import { AudioFrame } from '@kuralle-agents/livekit-plugin';
import { TransportAdapterBase } from './TransportAdapterBase.js';

export type TransportFactory<T extends TransportAdapterBase = TransportAdapterBase> = () =>
  | T
  | Promise<T>;

export interface TransportContractOptions {
  /** Skip the audio-input capability checks (for transports that never receive audio). */
  supportsAudioInput?: boolean;
  /**
   * Name used in logs. Defaults to the adapter's constructor name resolved
   * from the first factory invocation.
   */
  label?: string;
}

/**
 * Contract harness for any {@link TransportAdapterBase} implementation.
 * Called from a consuming test suite like:
 *
 *   runTransportContract(() => new MyTransport(fakeSocket));
 *
 * The harness performs a fixed sequence of invariants:
 *  1. `id` is a non-empty string.
 *  2. `isOpen` starts `true`.
 *  3. `audioInput`, `audioOutput`, `textOutput`, `config` are present.
 *  4. `config.sampleRate`, `numChannels`, `encoding` are non-null primitives.
 *  5. `captureFrame` on audioOutput does not throw synchronously for a
 *     trivial silence frame.
 *  6. `captureText` / `flush` on textOutput are callable without throwing.
 *  7. `close()` is idempotent (second call resolves cleanly).
 *  8. After close, `isOpen` is `false`.
 *  9. `on('close', ...)` fires exactly once.
 *
 * Returns a Promise that rejects on the first failed invariant. Designed to
 * be invoked from `bun:test` / `node:test` / vitest as the body of a test
 * case — each transport's contract test is a single `it('honors the
 * transport contract', () => runTransportContract(...))`.
 */
export async function runTransportContract(
  factory: TransportFactory,
  options: TransportContractOptions = {},
): Promise<void> {
  const adapter = await factory();
  const label = options.label ?? adapter.constructor.name;

  const assert = (cond: unknown, msg: string): void => {
    if (!cond) {
      throw new Error(`[runTransportContract:${label}] ${msg}`);
    }
  };

  assert(typeof adapter.id === 'string' && adapter.id.length > 0, 'adapter.id must be a non-empty string');
  assert(adapter.isOpen === true, 'adapter.isOpen must start true');
  assert(adapter.audioInput, 'adapter.audioInput is required');
  assert(adapter.audioOutput, 'adapter.audioOutput is required');
  assert(adapter.textOutput, 'adapter.textOutput is required');
  assert(adapter.config, 'adapter.config is required');
  assert(
    typeof adapter.config.sampleRate === 'number' && adapter.config.sampleRate > 0,
    'config.sampleRate must be a positive number',
  );
  assert(
    typeof adapter.config.numChannels === 'number' && adapter.config.numChannels > 0,
    'config.numChannels must be a positive number',
  );
  assert(typeof adapter.config.encoding === 'string', 'config.encoding must be a string');

  // Silence frame at the adapter's advertised sample rate.
  const samples = Math.max(1, Math.floor(adapter.config.sampleRate / 100));
  const silence = new Int16Array(samples * adapter.config.numChannels);
  const silenceFrame = new AudioFrame(
    silence,
    adapter.config.sampleRate,
    adapter.config.numChannels,
    samples,
  );

  // captureFrame must not throw synchronously on a well-formed frame.
  try {
    await adapter.audioOutput.captureFrame(silenceFrame);
  } catch (err) {
    throw new Error(
      `[runTransportContract:${label}] audioOutput.captureFrame threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // TextOutput must accept a simple string + flush.
  try {
    await adapter.textOutput.captureText('contract test');
    adapter.textOutput.flush();
  } catch (err) {
    throw new Error(
      `[runTransportContract:${label}] textOutput surface threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (options.supportsAudioInput !== false) {
    assert(
      'multiStream' in adapter.audioInput ||
        typeof (adapter.audioInput as { close?: unknown }).close === 'function',
      'audioInput must expose at least close()',
    );
  }

  // Close is idempotent and fires 'close' once.
  let closeCount = 0;
  adapter.on('close', () => {
    closeCount += 1;
  });

  await adapter.close();
  await adapter.close(); // idempotent

  assert(adapter.isOpen === false, 'adapter.isOpen must be false after close');
  assert(closeCount === 1, `'close' event must fire exactly once (got ${closeCount})`);
}
