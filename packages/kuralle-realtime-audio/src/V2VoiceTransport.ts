export interface RealtimeTransportSession {
  sendAudio(data: Uint8Array): void;
  onAudio(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onInterrupted?(handler: () => void): void;
  close(): void;
  clearAudioBuffer?(): void;
}
