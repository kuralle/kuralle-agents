// Ambient declarations for the alawmulaw submodule paths. Only the vendor
// shims (./mulaw.ts, ./alaw.ts) should import through these paths; all
// other code in the package imports the normalized shape from the shims.
declare module 'alawmulaw/lib/mulaw.js' {
  export function encode(samples: Int16Array): Uint8Array;
  export function decode(bytes: Uint8Array): Int16Array;
}

declare module 'alawmulaw/lib/alaw.js' {
  export function encode(samples: Int16Array): Uint8Array;
  export function decode(bytes: Uint8Array): Int16Array;
}

declare module 'alawmulaw' {
  export const mulaw: {
    encode(samples: Int16Array): Uint8Array;
    decode(bytes: Uint8Array): Int16Array;
  };
  export const alaw: {
    encode(samples: Int16Array): Uint8Array;
    decode(bytes: Uint8Array): Int16Array;
  };
}
