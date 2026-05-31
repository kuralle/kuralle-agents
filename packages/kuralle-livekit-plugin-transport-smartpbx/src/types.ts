export const DEFAULT_SMARTPBX_SAMPLE_RATE = 24000;
export const DEFAULT_WEBSOCKET_OPEN_STATE = 1;

export interface SmartPBXSocketLike {
  readyState: number;
  send: (data: string) => void;
}

export interface SmartPBXSessionState {
  callId: string;
  accountId: string;
  isActive: boolean;
}

export interface SmartPBXTransportAdapterOptions {
  socket: SmartPBXSocketLike;
  session: SmartPBXSessionState;
  sampleRate?: number;
  websocketOpenState?: number;
  onAudioFrame?: (frame: Float32Array, session: SmartPBXSessionState) => void;
  onText?: (text: string, session: SmartPBXSessionState) => void;
}
