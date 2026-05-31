/**
 * Whether debug logging is enabled. Checked at call time so it can be toggled
 * live. In the browser, enable with `window.KURALLE_DEBUG = true` (no rebuild or
 * bundler `define` needed); in Node, set `KURALLE_DEBUG=1`.
 */
function debugEnabled(): boolean {
  const g = globalThis as {
    KURALLE_DEBUG?: unknown;
    process?: { env?: Record<string, string | undefined> };
  };
  return Boolean(g.KURALLE_DEBUG ?? g.process?.env?.KURALLE_DEBUG);
}

/** Gated debug logger — a no-op unless debug is enabled (see debugEnabled).
 *  Keeps library output off a consumer's stdout by default while preserving traces. */
export function debug(...args: unknown[]): void {
  if (debugEnabled()) console.log(...args);
}
