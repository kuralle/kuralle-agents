/**
 * @module graph-api/meta-error-classifier
 *
 * Adapter that plugs Meta-specific error mapping (see {@link classifyMetaError})
 * into the generic {@link ErrorClassifier} interface exposed by
 * `@kuralle-agents/http-client`.
 */

import type { ClassifierContext, ErrorClassifier } from '@kuralle-agents/http-client';
import type { RetryableError } from '@kuralle-agents/http-client';
import {
  classifyMetaError,
  AuthenticationError,
  MessagingError,
  PermissionError,
  RateLimitError,
  RecipientError,
  TemplateError,
  WindowClosedError,
} from './errors.js';

/** HTTP statuses treated as transient when an error lacks a dedicated subclass. */
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Classifier that maps Meta Graph API error responses onto the `MessagingError`
 * hierarchy from `@kuralle-agents/messaging`. Augments each error with the
 * `retryable` + optional `retryAfterMs` flags required by the shared retry queue.
 */
export class MetaErrorClassifier implements ErrorClassifier {
  constructor(private readonly platform: string = 'meta') {}

  classify(ctx: ClassifierContext): MessagingError & RetryableError {
    const err = classifyMetaError(ctx.status, ctx.body, this.platform);
    return this.attachRetrySemantics(err, ctx.status);
  }

  private attachRetrySemantics(
    err: MessagingError,
    status: number,
  ): MessagingError & RetryableError {
    const augmented = err as MessagingError & RetryableError;

    if (err instanceof RateLimitError) {
      augmented.retryable = true;
      augmented.retryAfterMs = err.retryAfterMs;
      return augmented;
    }

    if (
      err instanceof AuthenticationError ||
      err instanceof PermissionError ||
      err instanceof RecipientError ||
      err instanceof WindowClosedError ||
      err instanceof TemplateError
    ) {
      augmented.retryable = false;
      return augmented;
    }

    // Fallback `MessagingError` — decide by HTTP status.
    const match = err.code.match(/^meta_error_(\d+)$/);
    const effectiveStatus = match ? parseInt(match[1], 10) : status;
    augmented.retryable = TRANSIENT_STATUSES.has(effectiveStatus);
    return augmented;
  }
}

/**
 * Parses Meta's usage headers (`x-app-usage`, `x-business-use-case-usage`) and
 * reports `true` when any usage bucket exceeds 80 %. Feed into the
 * `usageHeaderParser` option of {@link HttpClient}.
 */
export function metaUsageHeaderParser(headers: Headers): boolean {
  const appUsage = headers.get('x-app-usage');
  if (appUsage) {
    try {
      const parsed = JSON.parse(appUsage) as Record<string, number>;
      const maxPct = Math.max(
        parsed.call_count ?? 0,
        parsed.total_cputime ?? 0,
        parsed.total_time ?? 0,
      );
      return maxPct > 80;
    } catch {
      // fall through
    }
  }

  const bizUsage = headers.get('x-business-use-case-usage');
  if (bizUsage) {
    try {
      const parsed = JSON.parse(bizUsage) as Record<string, Array<Record<string, unknown>>>;
      let maxPct = 0;
      for (const buckets of Object.values(parsed)) {
        for (const bucket of buckets) {
          const rate = typeof bucket.rate_limit_usage === 'number' ? bucket.rate_limit_usage : 0;
          if (rate > maxPct) maxPct = rate;
        }
      }
      return maxPct > 80;
    } catch {
      // fall through
    }
  }

  return false;
}
