import type { Diagnostic } from './types.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function diagnostic(
  section: string,
  rule: string,
  origin: string,
  message: string,
): Diagnostic {
  return { section, rule, origin, message };
}

/**
 * A rejection carries the same `{ section, rule, message }` twice — once as the rejection
 * a caller reads, once as a diagnostic with an `origin` for a reader scanning the whole
 * load. Spelling both out by hand is how the two drifted apart three times in one function.
 */
export function rejection(
  section: string,
  rule: string,
  origin: string,
  message: string,
): { rejection: { section: string; rule: string; message: string }; diagnostics: Diagnostic[] } {
  return {
    rejection: { section, rule, message },
    diagnostics: [diagnostic(section, rule, origin, message)],
  };
}
