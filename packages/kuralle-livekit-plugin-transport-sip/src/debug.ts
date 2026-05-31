const ENABLED = typeof process !== 'undefined' && Boolean(process.env?.KURALLE_DEBUG);

/** Gated debug logger — a no-op unless KURALLE_DEBUG is set. Keeps library
 *  output off a consumer's stdout by default while preserving traces for debugging. */
export function debug(...args: unknown[]): void {
  if (ENABLED) console.log(...args);
}
