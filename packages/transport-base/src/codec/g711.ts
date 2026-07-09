/**
 * G.711 mu-law and A-law codec (CCITT/ITU-T compliant).
 *
 * Delegates to the `alawmulaw` npm package via resolver-agnostic
 * {@link ./vendor/mulaw} / {@link ./vendor/alaw} shims — see those files
 * for the interop rationale (issue #16). Do NOT import
 * `alawmulaw/lib/*.js` directly from this file or from any consumer;
 * go through the vendor shims so the shape-normalization lives in one
 * place.
 */
import * as mulaw from './vendor/mulaw.js';
import * as alaw from './vendor/alaw.js';

export interface Codec {
  readonly name: string;
  readonly payloadType: number;
  readonly sampleRate: number;
  readonly channels: number;
  decode(input: Uint8Array): Int16Array;
  encode(input: Int16Array): Uint8Array;
}

export const PCMU: Codec = {
  name: 'PCMU',
  payloadType: 0,
  sampleRate: 8000,
  channels: 1,
  decode(input: Uint8Array): Int16Array {
    return mulaw.decode(input);
  },
  encode(input: Int16Array): Uint8Array {
    return mulaw.encode(input);
  },
};

export const PCMA: Codec = {
  name: 'PCMA',
  payloadType: 8,
  sampleRate: 8000,
  channels: 1,
  decode(input: Uint8Array): Int16Array {
    return alaw.decode(input);
  },
  encode(input: Int16Array): Uint8Array {
    return alaw.encode(input);
  },
};

/** Convenience wrappers matching the Twilio transport API surface. */
export function mulawEncodeArray(pcm: Int16Array): Uint8Array {
  return PCMU.encode(pcm);
}

export function mulawDecodeArray(mulawBytes: Uint8Array): Int16Array {
  return PCMU.decode(mulawBytes);
}
