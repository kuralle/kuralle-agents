import { estimateTokenCount } from '../ContextBudget.js';

/** Token ceiling on a single tool result as the MODEL sees it, absent an explicit `Limits.maxToolResultTokens`. */
export const DEFAULT_MAX_TOOL_RESULT_TOKENS = 8_000;

export interface TruncatedToolResult {
  __truncated: { originalTokens: number; shownTokens: number; note: string };
  value: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** Backs `end` off until it does not split a UTF-8 multi-byte sequence. */
function safeSliceEnd(bytes: Uint8Array, end: number): number {
  let e = Math.min(Math.max(end, 0), bytes.length);
  while (e > 0 && isUtf8ContinuationByte(bytes[e])) e -= 1;
  return e;
}

/** Advances `start` until it does not split a UTF-8 multi-byte sequence. */
function safeSliceStart(bytes: Uint8Array, start: number): number {
  let s = Math.min(Math.max(start, 0), bytes.length);
  while (s < bytes.length && isUtf8ContinuationByte(bytes[s])) s += 1;
  return s;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Bounds a tool result to `maxTokens` as the MODEL will see it, truncating the middle so the
 * head (what happened first) and the tail (the error, the total, the last record) both survive.
 * Returns `value` unchanged (same reference) when it is already within budget.
 */
export function truncateForTranscript(
  value: unknown,
  maxTokens: number = DEFAULT_MAX_TOOL_RESULT_TOKENS,
): unknown | TruncatedToolResult {
  const text = typeof value === 'string' ? value : safeStringify(value);
  const originalTokens = estimateTokenCount(text);
  if (originalTokens <= maxTokens) return value;

  const marker = '\n…\n';
  const markerBytes = encoder.encode(marker).length;
  const budgetBytes = Math.max(maxTokens * 4 - markerBytes, 0);
  const bytes = encoder.encode(text);

  const headEnd = safeSliceEnd(bytes, Math.floor(budgetBytes / 2));
  const head = decoder.decode(bytes.subarray(0, headEnd));

  const tailBudget = budgetBytes - headEnd;
  const tailStart = safeSliceStart(bytes, Math.max(headEnd, bytes.length - tailBudget));
  const tail = decoder.decode(bytes.subarray(tailStart));

  const joined = `${head}${marker}${tail}`;
  const shownTokens = estimateTokenCount(joined);
  const note =
    `tool output truncated: ~${Math.max(originalTokens - shownTokens, 0)} tokens removed from ` +
    `the middle. Re-run the tool with narrower output to see the rest.`;

  return {
    __truncated: { originalTokens, shownTokens, note },
    value: joined,
  };
}
