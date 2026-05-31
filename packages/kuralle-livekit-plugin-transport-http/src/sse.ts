export interface SSEWriter {
  writeEvent(event: string, data: unknown): void;
  close(): void;
}

export function createSSEWriter(writable: WritableStream<Uint8Array>): SSEWriter {
  const encoder = new TextEncoder();
  const writer = writable.getWriter();

  return {
    writeEvent(event: string, data: unknown): void {
      const json = JSON.stringify(data);
      const message = `event: ${event}\ndata: ${json}\n\n`;
      writer.write(encoder.encode(message)).catch((err) => {
        console.error('[SSEWriter] Error writing event:', {
          event,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      });
    },

    close(): void {
      writer.close().catch((err) => {
        console.error('[SSEWriter] Error closing writer:', {
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      });
    },
  };
}

// --- Event Payloads ---

export interface SessionStartedEvent {
  sessionId: string;
}

export interface AgentTextEvent {
  text: string;
  isFinal: boolean;
}

export interface AgentAudioEvent {
  /** Base64-encoded raw PCM audio */
  audio: string;
  sampleRate: number;
  numChannels: number;
}

export interface UserTranscriptionEvent {
  text: string;
  isFinal: boolean;
}

export interface AgentStateEvent {
  state: 'initializing' | 'idle' | 'listening' | 'thinking' | 'speaking';
}

export interface SessionEndedEvent {
  reason: 'completed' | 'error' | 'client_disconnect' | 'server_shutdown';
}

export interface ErrorSSEEvent {
  message: string;
  code?: string;
}
