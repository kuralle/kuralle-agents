/**
 * @module shared/media-cache
 *
 * In-memory LRU cache for downloaded media attachments.
 *
 * Avoids re-downloading the same attachment when multiple handlers
 * or retry logic access the same media ID. Uses a Map-based LRU
 * with TTL expiration (media URLs from Meta are temporary -- typically
 * valid for ~5 minutes).
 */

// ====================================
// Config
// ====================================

/** Configuration for the {@link MediaCache}. */
export interface MediaCacheConfig {
  /** Max entries in the cache. Default: 100. */
  maxSize?: number;
  /** TTL for cached entries in ms. Default: 300_000 (5 minutes). */
  ttlMs?: number;
}

// ====================================
// Cached entry
// ====================================

/** A cached media entry with metadata. */
export interface CachedMedia {
  /** Raw media bytes. */
  data: Buffer;
  /** MIME type of the media. */
  mimeType: string;
  /** Original filename (if available). */
  filename?: string;
  /** Timestamp when the entry was cached (ms since epoch). */
  cachedAt: number;
}

// ====================================
// MediaCache
// ====================================

/**
 * In-memory LRU cache for downloaded media.
 *
 * Avoids re-downloading the same attachment when multiple handlers
 * or retry logic access the same media ID. Uses a Map-based LRU
 * with TTL expiration (media URLs from Meta are temporary -- typically
 * valid for ~5 minutes).
 */
export class MediaCache {
  private readonly cache: Map<string, CachedMedia>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(config?: MediaCacheConfig) {
    this.maxSize = config?.maxSize ?? 100;
    this.ttlMs = config?.ttlMs ?? 300_000;
    this.cache = new Map();
  }

  /**
   * Get cached media by ID. Returns `undefined` if not found or expired.
   *
   * Accessing an entry refreshes its LRU position (moves it to the end
   * of the eviction queue).
   *
   * @param mediaId - The platform-specific media identifier.
   * @returns The cached media entry, or `undefined`.
   */
  get(mediaId: string): CachedMedia | undefined {
    const entry = this.cache.get(mediaId);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.cache.delete(mediaId);
      return undefined;
    }

    // Move to end (LRU refresh)
    this.cache.delete(mediaId);
    this.cache.set(mediaId, entry);
    return entry;
  }

  /**
   * Store media in the cache.
   *
   * If the cache is at capacity, the least-recently-used entry is evicted.
   *
   * @param mediaId - The platform-specific media identifier.
   * @param media   - The media content to cache.
   */
  set(
    mediaId: string,
    media: { data: Buffer; mimeType: string; filename?: string },
  ): void {
    // If updating an existing key, delete first so it moves to the end
    if (this.cache.has(mediaId)) {
      this.cache.delete(mediaId);
    }

    // Evict if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(mediaId, { ...media, cachedAt: Date.now() });
  }

  /**
   * Check if media is cached and not expired.
   *
   * @param mediaId - The platform-specific media identifier.
   * @returns `true` if the media is cached and still valid.
   */
  has(mediaId: string): boolean {
    return this.get(mediaId) !== undefined;
  }

  /**
   * Wrap a download function with caching.
   *
   * If the media is cached, returns the cached version. Otherwise
   * calls `downloadFn`, caches the result, and returns it.
   *
   * @param mediaId    - The platform-specific media identifier.
   * @param downloadFn - A function that downloads the media.
   * @returns The media content (from cache or fresh download).
   */
  async getOrDownload(
    mediaId: string,
    downloadFn: () => Promise<{ data: Buffer; mimeType: string; filename?: string }>,
  ): Promise<{ data: Buffer; mimeType: string; filename?: string }> {
    const cached = this.get(mediaId);
    if (cached) {
      return { data: cached.data, mimeType: cached.mimeType, filename: cached.filename };
    }

    const result = await downloadFn();
    this.set(mediaId, result);
    return result;
  }

  /** Return the current number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
  }
}
