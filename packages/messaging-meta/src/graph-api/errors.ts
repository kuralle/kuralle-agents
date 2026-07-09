/**
 * @module graph-api/errors
 *
 * Meta-specific error classification helper.
 *
 * Imports the canonical error hierarchy from `@kuralle-agents/messaging` and
 * re-exports it alongside the {@link classifyMetaError} function. This ensures
 * that `instanceof` checks work correctly across the entire SDK — there is only
 * ONE `WindowClosedError` class, ONE `RateLimitError` class, etc.
 */

import {
  MessagingError,
  RateLimitError,
  AuthenticationError,
  PermissionError,
  RecipientError,
  WindowClosedError,
  TemplateError,
  MediaError,
  WebhookVerificationError,
} from '@kuralle-agents/messaging';

// Re-export so consumers of this module can access the error classes.
export {
  MessagingError,
  RateLimitError,
  AuthenticationError,
  PermissionError,
  RecipientError,
  WindowClosedError,
  TemplateError,
  MediaError,
  WebhookVerificationError,
};

// ---------------------------------------------------------------------------
// Meta error response shape
// ---------------------------------------------------------------------------

/** Shape of a Meta Graph API error response body. */
export interface MetaErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a Meta Graph API error response into a typed {@link MessagingError}.
 *
 * The mapping follows Meta's documented error codes:
 * - 429 / codes 4, 32, 613 -> {@link RateLimitError}
 * - 401 / code 190 -> {@link AuthenticationError}
 * - 403 / codes 10, 200 -> {@link PermissionError}
 * - 404 -> {@link RecipientError}
 * - code 131047 -> {@link WindowClosedError} (24-hour window expired)
 * - code 131026 -> {@link RecipientError} (not on WhatsApp)
 * - codes 132000-132999 -> {@link TemplateError}
 *
 * @param status  - HTTP status code from the response.
 * @param body    - Parsed JSON body (may be `null` if parsing failed).
 * @param platform - Platform identifier (e.g. `"whatsapp"`, `"messenger"`).
 * @returns A typed {@link MessagingError} subclass.
 */
export function classifyMetaError(
  status: number,
  body: unknown,
  platform: string,
): MessagingError {
  const parsed = body as MetaErrorResponse | null;
  const err = parsed?.error;
  const metaCode = err?.code;
  const metaSubcode = err?.error_subcode;
  const _fbtraceId = err?.fbtrace_id;
  const metaMessage = err?.message ?? `Meta API error (HTTP ${status})`;

  // --- Rate limiting (HTTP 429 or Meta codes 4, 32, 613) ---
  if (status === 429 || metaCode === 4 || metaCode === 32 || metaCode === 613) {
    return new RateLimitError(`Rate limited — retry after 5000ms`, platform, 5_000);
  }

  // --- Authentication (HTTP 401 or Meta code 190) ---
  if (status === 401 || metaCode === 190) {
    return new AuthenticationError(metaMessage, platform);
  }

  // --- Permissions (HTTP 403 or Meta codes 10, 200) ---
  if (status === 403 || metaCode === 10 || metaCode === 200) {
    return new PermissionError(metaMessage, platform);
  }

  // --- 24-hour window closed (WhatsApp 131047, Messenger 1545041) ---
  if (metaCode === 131047 || metaCode === 1545041) {
    return new WindowClosedError(metaMessage, platform, new Date());
  }

  // --- Person unavailable (Messenger 551) ---
  if (metaCode === 551 || metaSubcode === 551) {
    return new MessagingError(metaMessage, 'person_unavailable', platform);
  }

  // --- Recipient not reachable (HTTP 404 or Meta code 131026) ---
  if (status === 404 || metaCode === 131026) {
    return new RecipientError(metaMessage, platform);
  }

  // --- Template errors (Meta codes 132000-132999) ---
  if (metaCode !== undefined && metaCode >= 132000 && metaCode <= 132999) {
    return new TemplateError(metaMessage, platform);
  }

  // --- Template sub-code errors (some come through subcode) ---
  if (metaSubcode !== undefined && metaSubcode >= 132000 && metaSubcode <= 132999) {
    return new TemplateError(metaMessage, platform);
  }

  // --- Fallback ---
  return new MessagingError(metaMessage, `meta_error_${metaCode ?? status}`, platform);
}
