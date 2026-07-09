/**
 * @module @kuralle-agents/http-client
 *
 * Generic HTTP client with exponential-backoff retry, token-bucket rate
 * limiting, and pluggable error classification.
 *
 * @example
 * ```ts
 * import { HttpClient, DefaultHttpClassifier } from '@kuralle-agents/http-client';
 *
 * const client = new HttpClient({
 *   baseUrl: 'https://api.example.com/v1',
 *   defaultHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
 * });
 *
 * const user = await client.get<User>('users/42');
 * ```
 */

export { HttpClient } from './client.js';
export type { HttpClientConfig, HeaderFactory, Logger } from './client.js';

export { RetryQueue, DEFAULT_RETRY_CONFIG, isRetryableError } from './retry.js';
export type { RetryConfig, RetryableError } from './retry.js';

export { RateLimiter, DEFAULT_RATE_LIMITER_CONFIG } from './rate-limiter.js';
export type { RateLimiterConfig, UsageHeaderParser } from './rate-limiter.js';

export { DefaultHttpClassifier, HttpError } from './classifier.js';
export type { ErrorClassifier, ClassifierContext } from './classifier.js';
