/**
 * Context-overflow detection + recovery.
 *
 * Provider error classifier and session-recovery helper used by
 * AgentExecuteStage to turn a fatal context-overflow error into a
 * single retry after force-compaction.
 *
 * AI SDK v6 error model (researched against /vercel/ai @ ai_6.0.0-beta.128):
 *   - `APICallError.isInstance(error)` is the canonical type guard
 *     (the v4+ replacement for the deprecated `isAPICallError` static).
 *   - APICallError exposes `statusCode`, `responseBody`, `cause`, `url`.
 *   - During `streamText`, errors surface BOTH ways: as a thrown
 *     exception around the iterator AND as `chunk.type === 'error'`
 *     parts inside `fullStream`. Callers must handle both.
 *
 * Provider-specific overflow signatures (researched against current docs +
 * gh search across 10 production codebases that ship their own classifier):
 *   - OpenAI:    `code: 'context_length_exceeded'`, or message containing
 *                'maximum context length' / 'reduce the length of the
 *                messages' / 'context_length_exceeded'.
 *   - Anthropic: status 400 with message containing 'prompt is too long'.
 *   - Generic:   status 400 with message matching
 *                /context.{0,20}(window|length|tokens)/i.
 *
 * Why the matching is intentionally OR-shaped (not provider-switched):
 * proxies (OpenRouter, LiteLLM, Portkey, Bedrock) reshape the original
 * provider error, so a strict provider-by-provider switch silently
 * mis-classifies the same overflow on the same model when routed
 * through a proxy. The cost of a false positive is a wasted retry; the
 * cost of a false negative is a fatal turn loss. Bias OR.
 */
import type { Session } from '../types/index.js';

// Pre-compiled message patterns — keep tight and audited; loose patterns
// inflate false positives across providers.
const OVERFLOW_MESSAGE_PATTERNS: RegExp[] = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /reduce the length of the messages/i,
  /context.{0,20}(window|length|tokens)/i,
  /exceeds the (?:maximum|model'?s) context/i,
  /input is too long/i,
];

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.statusCode === 'number') return e.statusCode;
  if (typeof e.status === 'number') return e.status;
  const cause = e.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause === 'object') {
    if (typeof cause.statusCode === 'number') return cause.statusCode;
    if (typeof cause.status === 'number') return cause.status;
  }
  return undefined;
}

function extractCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.code === 'string') return e.code;
  // Anthropic + OpenRouter sometimes nest under data.error.code
  const data = e.data as Record<string, unknown> | undefined;
  const inner = data && (data.error as Record<string, unknown> | undefined);
  if (inner && typeof inner.code === 'string') return inner.code;
  return undefined;
}

function extractMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    // AI SDK APICallError surfaces the raw provider body
    if (typeof e.responseBody === 'string') return e.responseBody;
  }
  try {
    return String(error);
  } catch {
    return '';
  }
}

/**
 * Returns true if the error is a provider context-overflow / "prompt too
 * long" condition. Matches on AI SDK APICallError + raw provider errors +
 * proxy-reshaped errors.
 *
 * Bias: tolerate false positives (wasted retry), reject false negatives
 * (fatal turn loss).
 */
export function isContextOverflowError(error: unknown): boolean {
  if (error == null || typeof error === 'string') {
    // string-only errors lose status; defer to message pattern only
    if (typeof error === 'string') {
      return OVERFLOW_MESSAGE_PATTERNS.some(p => p.test(error));
    }
    return false;
  }
  if (typeof error !== 'object') return false;

  // OpenAI code wins immediately — it's unambiguous across SDK shapes.
  if (extractCode(error) === 'context_length_exceeded') return true;

  const status = extractStatus(error);
  const message = extractMessage(error);

  // For an AI SDK APICallError or raw provider error: require BOTH a 400
  // family status AND a matching message. This avoids matching unrelated
  // 500-level errors whose stack happens to mention the word "context".
  if (status === 400 || status === 413) {
    return OVERFLOW_MESSAGE_PATTERNS.some(p => p.test(message));
  }

  // Some providers/proxies don't surface a status at all (raw fetch
  // failure, plain Error). Fall back to message-only when no status is
  // present — accept the looser match.
  if (status === undefined) {
    return OVERFLOW_MESSAGE_PATTERNS.some(p => p.test(message));
  }

  return false;
}

export interface OverflowRecoveryResult {
  /** Whether at least one message was stripped from session.messages. */
  stripped: boolean;
  /** Number of messages stripped. */
  strippedCount: number;
}

/**
 * Strip partial assistant + tool messages that followed the most recent
 * user message — these are in-flight work from the turn that overflowed.
 * The user's own message is PRESERVED so the retry can still answer it.
 *
 * Why we keep the user message:
 *   1. The user asked a question. Throwing it away to "recover" is worse
 *      than just failing — they have to re-type it.
 *   2. Overflow is almost always caused by accumulated PRIOR-turn weight
 *      (long tool outputs, growing history), not by the new user message
 *      itself. Once compaction trims the history, the same user message
 *      fits.
 *   3. Matches Flue's recovery semantics: "strip the failed turn" means
 *      strip the partial response, not the prompt.
 *
 * Does NOT trigger compaction itself — that's the caller's job, so it
 * can pass `force: true` and pick the right strategy. This function is
 * pure session mutation and is safe to call before any awaitable work.
 *
 * Returns the count of messages stripped. A retry is valid even when
 * `strippedCount === 0` (e.g. brand-new turn, nothing in-flight to
 * strip) — the caller decides based on its overall recovery policy.
 */
export async function recoverFromContextOverflow(
  session: Session,
): Promise<OverflowRecoveryResult> {
  const messages = session.messages;
  if (!messages || messages.length === 0) {
    return { stripped: false, strippedCount: 0 };
  }

  // Walk backward to find the most recent user message.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i] as { role?: string }).role;
    if (role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) {
    return { stripped: false, strippedCount: 0 };
  }

  // Keep the user message; strip ONLY the assistant/tool messages that
  // came after it (the partial in-flight response).
  const strippedCount = messages.length - 1 - lastUserIdx;
  if (strippedCount > 0) {
    session.messages = messages.slice(0, lastUserIdx + 1);
    return { stripped: true, strippedCount };
  }

  // Nothing to strip — the user message has no trailing partial work.
  // Still a valid recovery path: the caller can compact prior history
  // OR simply retry against a possibly-transient provider error.
  return { stripped: false, strippedCount: 0 };
}
