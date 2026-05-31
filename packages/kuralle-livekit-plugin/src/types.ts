export type AudioEncoding =
  | 'pcm_s16le'
  | 'pcm_f32le'
  | 'mulaw'
  | 'alaw'
  | 'opus'
  | 'mp3';

export interface TransportAdapterConfig {
  sampleRate: number;
  numChannels: number;
  encoding: AudioEncoding;
  samplesPerChannel: number | null;
}

export enum TransportEvent {
  CONNECTED = 'transport.connected',
  DISCONNECTED = 'transport.disconnected',
  ERROR = 'transport.error',
  AUDIO_STARTED = 'transport.audio_started',
  AUDIO_STOPPED = 'transport.audio_stopped',
}

export interface TransportSessionInfo {
  sessionId: string;
  transportType: string;
  createdAt: Date;
  remoteAddress?: string;
  metadata?: Record<string, unknown>;
}
