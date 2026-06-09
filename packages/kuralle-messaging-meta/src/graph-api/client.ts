/**
 * @module graph-api/client
 *
 * Typed HTTP client for Meta's Graph API.
 *
 * Thin wrapper around {@link HttpClient} from `@kuralle-agents/http-client`.
 * Supplies Meta-specific concerns — base URL versioning, bearer-token auth,
 * `access_token` query param, `MetaErrorClassifier`, and `metaUsageHeaderParser`
 * — while delegating retry, rate-limiting, and transport to the generic core.
 */

import { HttpClient } from '@kuralle-agents/http-client';
import type { Logger, RetryConfig, RateLimiterConfig } from '@kuralle-agents/http-client';
import { MetaErrorClassifier, metaUsageHeaderParser } from './meta-error-classifier.js';

export type { Logger };

/** Configuration for {@link GraphAPIClient}. */
export interface GraphAPIClientConfig {
  /** Long-lived or system-user access token for the Graph API. */
  accessToken: string;
  /** App secret used for webhook signature verification and appsecret_proof. */
  appSecret: string;
  /** Graph API version (e.g. `"v24.0"`). Default `"v24.0"`. */
  apiVersion?: string;
  /** Base URL for the Graph API. Default `"https://graph.facebook.com"`. */
  baseUrl?: string;
  /** Retry configuration. Uses sensible defaults when omitted. */
  retry?: Partial<RetryConfig>;
  /** Rate limiter configuration. Uses sensible defaults when omitted. */
  rateLimiter?: Partial<RateLimiterConfig>;
  /** Platform tag (e.g. `"whatsapp"`) used when classifying errors. Default `"meta"`. */
  platform?: string;
  /** Optional logger for request/response tracing. */
  logger?: Logger;
}

/**
 * Typed HTTP client for Meta's Graph API.
 *
 * @example
 * ```ts
 * const client = new GraphAPIClient({
 *   accessToken: process.env.META_ACCESS_TOKEN!,
 *   appSecret: process.env.META_APP_SECRET!,
 * });
 * const profile = await client.get<{ name: string }>('me', { fields: 'name' });
 * ```
 */
export class GraphAPIClient {
  private readonly accessToken: string;
  private readonly appSecret: string;
  private readonly http: HttpClient;

  constructor(config: GraphAPIClientConfig) {
    this.accessToken = config.accessToken;
    this.appSecret = config.appSecret;

    const apiVersion = config.apiVersion ?? 'v24.0';
    const baseUrl = (config.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');

    this.http = new HttpClient({
      baseUrl: `${baseUrl}/${apiVersion}`,
      defaultHeaders: () => ({
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      }),
      classifier: new MetaErrorClassifier(config.platform ?? 'meta'),
      usageHeaderParser: metaUsageHeaderParser,
      retry: config.retry,
      rateLimiter: config.rateLimiter,
      logger: config.logger,
    });
  }

  /** GET with `access_token` query param applied. */
  async get<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    return this.http.get<T>(endpoint, { access_token: this.accessToken, ...(params ?? {}) });
  }

  /** POST with a JSON body. Authorization header carries the bearer token. */
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.http.post<T>(endpoint, body);
  }

  /** POST with a multipart body (e.g. media uploads). */
  async postFormData<T>(endpoint: string, formData: FormData): Promise<T> {
    return this.http.postFormData<T>(endpoint, formData);
  }

  /** DELETE with `access_token` query param applied. */
  async delete<T>(
    endpoint: string,
    opts?: { params?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    return this.http.delete<T>(endpoint, {
      params: { access_token: this.accessToken, ...(opts?.params ?? {}) },
      body: opts?.body,
    });
  }

  /** Fetch a binary resource from an absolute CDN URL. */
  async fetchBinary(url: string): Promise<Buffer> {
    return this.http.fetchBinary(url);
  }

  /** App secret proof generation is left to callers that need it (not part of the HTTP layer). */
  getAppSecret(): string {
    return this.appSecret;
  }
}
