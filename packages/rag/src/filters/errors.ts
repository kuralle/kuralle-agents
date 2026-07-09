/**
 * Thrown by a vector-filter translator when the requested operator is not
 * supported by the target backend. Carries enough context for the caller to
 * either restructure the query or fall back to post-filtering.
 */
export class UnsupportedFilterOperatorError extends Error {
  readonly backend: string;
  readonly operator: string;
  readonly reason?: string;

  constructor(options: {
    backend: string;
    operator: string;
    reason?: string;
  }) {
    const suffix = options.reason ? ` — ${options.reason}` : '';
    super(
      `[${options.backend}] operator "${options.operator}" is not supported${suffix}`,
    );
    this.name = 'UnsupportedFilterOperatorError';
    this.backend = options.backend;
    this.operator = options.operator;
    this.reason = options.reason;
  }
}
