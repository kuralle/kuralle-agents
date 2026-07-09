// --- Client -> Server Messages ---

export interface ConfigureMessage {
  type: 'configure';
  sampleRate?: number;
  numChannels?: number;
  encoding?: 'pcm_s16le' | 'mulaw' | 'alaw';
}

export interface UserTextMessage {
  type: 'user_text';
  text: string;
}

export interface EndOfAudioMessage {
  type: 'end_of_audio';
}

// --- Server -> Client Messages ---

export interface SessionStartedMessage {
  type: 'session_started';
  sessionId: string;
  config: {
    sampleRate: number;
    numChannels: number;
    encoding: string;
  };
}

export interface AgentTextMessage {
  type: 'agent_text';
  text: string;
  isFinal: boolean;
}

/**
 * @experimental Not currently emitted by the runtime. STT transcription events
 * flow through the LiveKit AgentSession internal pipeline and are not surfaced
 * to the WS client. Reserved for future observability needs.
 */
export interface UserTranscriptionMessage {
  type: 'user_transcription';
  text: string;
  isFinal: boolean;
}

/**
 * @experimental Not currently emitted by the runtime. State machine transitions
 * are implicit inside the LiveKit AgentSession. Reserved for future UI state
 * indicator support.
 */
export interface AgentStateMessage {
  type: 'agent_state';
  state: 'initializing' | 'idle' | 'listening' | 'thinking' | 'speaking';
}

export interface UserStateMessage {
  type: 'user_state';
  state: 'speaking' | 'listening' | 'away';
}

export interface ToolResultMessage {
  type: 'tool_result';
  toolName: string;
  success: boolean;
}

export interface MetricsMessage {
  type: 'metrics_collected';
  metricsType?: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  code?: string;
}

/**
 * @experimental Not currently emitted by the runtime. Session end is communicated
 * via the WebSocket close frame. The client discovers session end when the WS
 * connection closes. Reserved for explicit lifecycle signaling if needed.
 */
export interface SessionEndedMessage {
  type: 'session_ended';
  reason: 'completed' | 'error' | 'client_disconnect' | 'server_shutdown';
}

// --- Union types ---

export type ClientMessage = ConfigureMessage | UserTextMessage | EndOfAudioMessage;
export type ServerMessage =
  | SessionStartedMessage
  | AgentTextMessage
  | UserTranscriptionMessage
  | AgentStateMessage
  | UserStateMessage
  | ToolResultMessage
  | MetricsMessage
  | ErrorMessage
  | SessionEndedMessage;

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isValidEncoding(value: unknown): value is ConfigureMessage['encoding'] {
  return value === 'pcm_s16le' || value === 'mulaw' || value === 'alaw';
}

export function parseClientMessage(data: string): ClientMessage | null {
  try {
    const msg = JSON.parse(data);
    if (!msg || typeof msg.type !== 'string') return null;

    switch (msg.type) {
      case 'configure': {
        if (msg.sampleRate !== undefined && !isFinitePositiveNumber(msg.sampleRate)) {
          return null;
        }
        if (msg.numChannels !== undefined && !isFinitePositiveNumber(msg.numChannels)) {
          return null;
        }
        if (msg.encoding !== undefined && !isValidEncoding(msg.encoding)) {
          return null;
        }
        return msg as ConfigureMessage;
      }
      case 'user_text':
        if (typeof msg.text !== 'string') {
          return null;
        }
        return msg as UserTextMessage;
      case 'end_of_audio':
        return msg as EndOfAudioMessage;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
