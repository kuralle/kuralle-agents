/**
 * @module client
 *
 * Generic retrying + rate-limited HTTP client.
 *
 * Wraps `fetch` with an {@link RetryQueue}, a {@link RateLimiter}, and a
 * pluggable {@link ErrorClassifier}. The classifier owns response
 * interpretation; the client owns transport concerns.
 */

import { RetryQueue } from './retry.js';
import type { RetryConfig } from './retry.js';
import { RateLimiter } from './rate-limiter.js';
import type { RateLimiterConfig, UsageHeaderParser } from './rate-limiter.js';
import { DefaultHttpClassifier } from './classifier.js';
import type { ErrorClassifier } from './classifier.js';

/** Minimal structured logger accepted by the client. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Provide default headers for every request. Can be dynamic (e.g. bearer refresh). */
export type HeaderFactory = Record<string, string> | (() => Record<string, string>);

/** Configuration for {@link HttpClient}. */
export interface HttpClientConfig {
  /**
   * Base URL prepended to relative endpoint paths (e.g. `https://graph.facebook.com/v21.0`).
   * If empty, callers must pass absolute URLs.
   */
  baseUrl?: string;
  /** Default headers applied to every request. */
  defaultHeaders?: HeaderFactory;
  /** Classifier that turns non-2xx responses into typed errors. */
  classifier?: ErrorClassifier;
  /** Retry configuration. Uses sensible defaults when omitted. */
  retry?: Partial<RetryConfig>;
  /** Rate limiter configuration. Uses sensible defaults when omitted. */
  rateLimiter?: Partial<RateLimiterConfig>;
  /** Optional parser that signals quota-exhausted conditions from response headers. */
  usageHeaderParser?: UsageHeaderParser;
  /** Optional logger for request/response tracing. */
  logger?: Logger;
  /** Injected fetch implementation (primarily for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Generic HTTP client with retry, rate-limit, and pluggable error classification.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly defaultHeaders: HeaderFactory;
  private readonly classifier: ErrorClassifier;
  private readonly retryQueue: RetryQueue;
  private readonly rateLimiter: RateLimiter;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.classifier = config.classifier ?? new DefaultHttpClassifier();
    this.retryQueue = new RetryQueue(config.retry);
    this.rateLimiter = new RateLimiter(config.rateLimiter, config.usageHeaderParser);
    this.logger = config.logger;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Perform a GET request and parse the JSON response. */
  async get<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    this.logger?.debug('[HttpClient] GET %s', url);
    return this.executeJson<T>(url, { method: 'GET', headers: this.resolveHeaders() });
  }

  /** Perform a POST request with a JSON body. */
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    const url = this.buildUrl(endpoint);
    this.logger?.debug('[HttpClient] POST %s', url);
    return this.executeJson<T>(url, {
      method: 'POST',
      headers: { ...this.resolveHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Perform a DELETE request; optional query params and JSON body. */
  async delete<T>(
    endpoint: string,
    opts?: { params?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    const url = this.buildUrl(endpoint, opts?.params);
    this.logger?.debug('[HttpClient] DELETE %s', url);
    const headers = this.resolveHeaders();
    const init: RequestInit = { method: 'DELETE', headers };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return this.executeJson<T>(url, init);
  }

  /** Perform a POST request with a multipart body. */
  async postFormData<T>(endpoint: string, formData: FormData): Promise<T> {
    const url = this.buildUrl(endpoint);
    this.logger?.debug('[HttpClient] POST (form-data) %s', url);
    // Do NOT set Content-Type — `fetch` sets the boundary.
    const { 'Content-Type': _omit, ...headers } = { ...this.resolveHeaders() } as Record<string, string>;
    return this.executeJson<T>(url, { method: 'POST', headers, body: formData });
  }

  /** Fetch a binary resource from an absolute URL (no base-URL prefixing). */
  async fetchBinary(url: string): Promise<Buffer> {
    this.logger?.debug('[HttpClient] FETCH_BINARY %s', url);
    return this.retryQueue.execute(async () => {
      await this.rateLimiter.acquire();
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.resolveHeaders(),
        });
        this.rateLimiter.updateFromHeaders(response.headers);
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw this.classifier.classify({
            status: response.status,
            body,
            url,
            method: 'GET',
            headers: response.headers,
          });
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      } finally {
        this.rateLimiter.release();
      }
    });
  }

  private buildUrl(endpoint: string, params?: Record<string, string>): string {
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const base = /^https?:/i.test(cleanEndpoint) ? '' : `${this.baseUrl}/`;
    const url = new URL(`${base}${cleanEndpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private resolveHeaders(): Record<string, string> {
    const h = typeof this.defaultHeaders === 'function' ? this.defaultHeaders() : this.defaultHeaders;
    return { Accept: 'application/json', ...h };
  }

  private async executeJson<T>(url: string, init: RequestInit): Promise<T> {
    return this.retryQueue.execute(async () => {
      await this.rateLimiter.acquire();
      try {
        const response = await this.fetchImpl(url, init);
        this.rateLimiter.updateFromHeaders(response.headers);
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw this.classifier.classify({
            status: response.status,
            body,
            url,
            method: init.method ?? 'GET',
            headers: response.headers,
          });
        }
        return (await response.json()) as T;
      } finally {
        this.rateLimiter.release();
      }
    });
  }
}
