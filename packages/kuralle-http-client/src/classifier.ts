/**
 * @module classifier
 *
 * Error-classifier plugin surface.
 *
 * The {@link HttpClient} itself does not know how to interpret non-2xx
 * responses. Integrators provide an {@link ErrorClassifier} that maps
 * `{ status, body }` to a typed error carrying `retryable` + optional
 * `retryAfterMs`. The retry queue then uses those flags to decide whether
 * to reattempt the request.
 */

import type { RetryableError } from './retry.js';

/** Context passed to the classifier when a non-2xx response is received. */
export interface ClassifierContext {
  /** HTTP status code. */
  status: number;
  /** Parsed response body (JSON, or `null` if parsing failed). */
  body: unknown;
  /** Absolute URL the request was sent to. */
  url: string;
  /** HTTP method of the failed request. */
  method: string;
  /** Raw response headers. */
  headers: Headers;
}

/**
 * Produces an Error augmented with retry semantics.
 *
 * Implementations MUST return an `Error` instance and MUST set `retryable`
 * so the retry queue can make a decision.
 */
export interface ErrorClassifier {
  classify(ctx: ClassifierContext): Error & RetryableError;
}

/**
 * Default classifier — maps common HTTP status codes onto retry semantics.
 *
 * Useful as a fallback when a caller doesn't have a domain-specific
 * classifier yet. Returns a plain `HttpError`.
 */
export class DefaultHttpClassifier implements ErrorClassifier {
  constructor(
    private readonly retryableStatuses: number[] = [408, 425, 429, 500, 502, 503, 504],
  ) {}

  classify(ctx: ClassifierContext): Error & RetryableError {
    const retryable = this.retryableStatuses.includes(ctx.status);
    const message = `HTTP ${ctx.status} ${ctx.method} ${ctx.url}`;
    const err = new HttpError(message, ctx.status, ctx.body);
    err.retryable = retryable;
    if (ctx.status === 429) {
      const ra = parseRetryAfter(ctx.headers.get('retry-after'));
      if (ra !== undefined) err.retryAfterMs = ra;
    }
    return err;
  }
}

/** Generic non-2xx HTTP error used by {@link DefaultHttpClassifier}. */
export class HttpError extends Error implements RetryableError {
  public retryable = false;
  public retryAfterMs?: number;

  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1_000;
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}
