/**
 * @module shared/media-strategy
 *
 * Strategy pattern for resolving a `MediaPayload` into something a platform
 * can send. Platforms differ in whether they accept direct URLs, require
 * binary uploads, or benefit from deduplicated re-uploads by content hash.
 *
 * Three built-in strategies:
 * - {@link HttpUrlStrategy} — expects `data` to already be an `http(s)://` URL.
 * - {@link UploadStrategy} — uploads a `Buffer` / `ReadableStream` via the
 *   supplied `uploader`, returns a `MediaHandle`.
 * - {@link FileHashDedupStrategy} — decorator. Hashes binary content, checks
 *   {@link MediaCache}, reuses an existing `MediaHandle` on cache hit, falls
 *   through to the wrapped strategy on miss.
 */

import { createHash } from 'node:crypto';
import type { MediaHandle, MediaPayload, MediaUploadOptions } from '../types.js';

/** Result of resolving a {@link MediaPayload}: either a URL or a platform media handle. */
export type ResolvedMedia =
  | { kind: 'url'; url: string; mimeType: string }
  | { kind: 'handle'; handle: MediaHandle; mimeType: string };

/** Uploader function supplied to {@link UploadStrategy}. Typically a `PlatformClient.uploadMedia` bound method. */
export type MediaUploader = (
  data: Buffer | ReadableStream,
  options: MediaUploadOptions,
) => Promise<MediaHandle>;

/** Strategy interface. */
export interface MediaStrategy {
  resolve(payload: MediaPayload): Promise<ResolvedMedia>;
}

/**
 * Pass a URL straight through. Throws if the payload's `data` is not a string.
 */
export class HttpUrlStrategy implements MediaStrategy {
  async resolve(payload: MediaPayload): Promise<ResolvedMedia> {
    if (typeof payload.data !== 'string') {
      throw new Error('HttpUrlStrategy requires payload.data to be a URL string');
    }
    if (!/^https?:\/\//i.test(payload.data)) {
      throw new Error(`HttpUrlStrategy received non-http(s) data: ${payload.data.slice(0, 40)}`);
    }
    return { kind: 'url', url: payload.data, mimeType: payload.mimeType };
  }
}

/**
 * Upload binary content (Buffer / ReadableStream) through the supplied uploader
 * and return the resulting {@link MediaHandle}. If `data` is already a string
 * URL, delegates to {@link HttpUrlStrategy}.
 */
export class UploadStrategy implements MediaStrategy {
  constructor(private readonly uploader: MediaUploader) {}

  async resolve(payload: MediaPayload): Promise<ResolvedMedia> {
    if (typeof payload.data === 'string') {
      return new HttpUrlStrategy().resolve(payload);
    }
    const handle = await this.uploader(payload.data, {
      mimeType: payload.mimeType,
      filename: payload.filename,
    });
    return { kind: 'handle', handle, mimeType: payload.mimeType };
  }
}

/**
 * Minimal store contract used by {@link FileHashDedupStrategy}. An in-memory
 * Map works fine; callers that need distributed dedup can supply a
 * Redis-backed implementation.
 */
export interface UploadHandleStore {
  get(hash: string): MediaHandle | undefined | Promise<MediaHandle | undefined>;
  set(hash: string, handle: MediaHandle): void | Promise<void>;
}

function createDefaultHandleStore(): UploadHandleStore {
  const m = new Map<string, MediaHandle>();
  return {
    get: (hash) => m.get(hash),
    set: (hash, handle) => {
      m.set(hash, handle);
    },
  };
}

/**
 * Decorator that deduplicates uploads by content hash.
 *
 * Only kicks in when the payload is a `Buffer`. `ReadableStream` payloads are
 * passed through to the inner strategy without hashing (hashing would drain
 * the stream). Cache hits return the stored `MediaHandle` without invoking
 * the inner strategy.
 */
export class FileHashDedupStrategy implements MediaStrategy {
  private readonly store: UploadHandleStore;

  constructor(inner: MediaStrategy, store?: UploadHandleStore) {
    this.inner = inner;
    this.store = store ?? createDefaultHandleStore();
  }

  private readonly inner: MediaStrategy;

  async resolve(payload: MediaPayload): Promise<ResolvedMedia> {
    if (!Buffer.isBuffer(payload.data)) {
      return this.inner.resolve(payload);
    }

    const hash = createHash('sha256').update(payload.data).digest('hex');
    const cached = await this.store.get(hash);
    if (cached) {
      return { kind: 'handle', handle: cached, mimeType: payload.mimeType };
    }

    const resolved = await this.inner.resolve(payload);
    if (resolved.kind === 'handle') {
      await this.store.set(hash, resolved.handle);
    }
    return resolved;
  }
}
