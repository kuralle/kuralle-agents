import type { AudioInput, AudioOutput, TextOutput } from './livekit_io.js';
import type { TransportAdapterConfig } from './types.js';

/**
 * Base class for all transport adapters. A transport adapter represents a
 * single connection (one caller, one WebSocket client, one HTTP session)
 * and provides the I/O implementations that AgentSession needs.
 *
 * Subclasses must implement the abstract properties and close().
 */
export abstract class TransportAdapter {
  abstract readonly id: string;
  abstract readonly audioInput: AudioInput;
  abstract readonly audioOutput: AudioOutput;
  abstract readonly textOutput: TextOutput;
  abstract readonly config: TransportAdapterConfig;

  abstract close(): Promise<void>;
  abstract get isOpen(): boolean;
}
