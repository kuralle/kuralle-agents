declare module 'alawmulaw/lib/alaw.js' {
  export function encodeSample(sample: number): number;
  export function decodeSample(sample: number): number;
}

declare module 'alawmulaw/lib/mulaw.js' {
  export function encodeSample(sample: number): number;
  export function decodeSample(sample: number): number;
}
