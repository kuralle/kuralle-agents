/**
 * Port interface for native (Gemini Live / Path B) audio I/O.
 * Parallel to {@link RealtimeTransportSession} in core, but owned here and
 * without optional interruption hooks.
 */
export interface NativeAudioTransport {
  /** Send PCM s16le audio to the end-user client (bytes = Int16 LE samples). */
  sendAudio(data: Uint8Array): void;
  /** Subscribe to PCM s16le from the end-user client. */
  onAudio(handler: (data: Uint8Array) => void): void;
  /** Subscribe to transport close (may fire multiple times; handlers should be idempotent). */
  onClose(handler: () => void): void;
  close(): void;
}
