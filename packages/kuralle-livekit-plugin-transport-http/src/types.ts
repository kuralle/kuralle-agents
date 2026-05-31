export interface UserTextInput {
  type: 'user_text';
  text: string;
}

export interface UserAudioInput {
  type: 'user_audio';
  /** Base64-encoded raw PCM audio */
  audio: string;
  sampleRate: number;
  numChannels: number;
}

export interface EndSessionInput {
  type: 'end_session';
}

export type ClientInput = UserTextInput | UserAudioInput | EndSessionInput;

export interface HTTPTransportOptions {
  /** Base path for session endpoints. Default: '/session'. */
  basePath?: string;
  /** Default audio sample rate. Default: 24000. */
  defaultSampleRate?: number;
  /** Default number of audio channels. Default: 1. */
  defaultNumChannels?: number;
  /** Maximum request body size in bytes. Default: 10MB. */
  maxBodySize?: number;
  /** Session timeout in milliseconds. Default: 300000 (5 minutes). */
  sessionTimeout?: number;
}
