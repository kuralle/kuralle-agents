import { describe, it, expect, mock } from 'bun:test';
import { MediaCache } from '../src/shared/media-cache.js';

describe('MediaCache', () => {
  it('returns undefined for an unknown media ID', () => {
    const cache = new MediaCache();
    expect(cache.get('unknown-id')).toBeUndefined();
  });

  it('stores and retrieves cached media', () => {
    const cache = new MediaCache();
    const media = { data: Buffer.from('hello'), mimeType: 'image/png', filename: 'test.png' };
    cache.set('media-1', media);

    const result = cache.get('media-1');
    expect(result).toBeDefined();
    expect(result!.data).toEqual(media.data);
    expect(result!.mimeType).toBe('image/png');
    expect(result!.filename).toBe('test.png');
    expect(result!.cachedAt).toBeGreaterThan(0);
  });

  it('returns undefined for expired entries', () => {
    const cache = new MediaCache({ ttlMs: 1 });
    cache.set('media-1', { data: Buffer.from('x'), mimeType: 'image/png' });

    // Wait for expiration
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    expect(cache.get('media-1')).toBeUndefined();
  });

  it('evicts the LRU entry when maxSize is exceeded', () => {
    const cache = new MediaCache({ maxSize: 2 });

    cache.set('a', { data: Buffer.from('a'), mimeType: 'text/plain' });
    cache.set('b', { data: Buffer.from('b'), mimeType: 'text/plain' });
    cache.set('c', { data: Buffer.from('c'), mimeType: 'text/plain' });

    // 'a' should have been evicted
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('has() returns true for cached and false for missing/expired', () => {
    const cache = new MediaCache({ ttlMs: 1 });
    cache.set('media-1', { data: Buffer.from('x'), mimeType: 'image/png' });

    expect(cache.has('media-1')).toBe(true);
    expect(cache.has('nonexistent')).toBe(false);

    // Wait for expiration
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    expect(cache.has('media-1')).toBe(false);
  });

  it('getOrDownload calls download on cache miss', async () => {
    const cache = new MediaCache();
    const downloadFn = mock(async () => ({
      data: Buffer.from('downloaded'),
      mimeType: 'image/jpeg',
    }));

    const result = await cache.getOrDownload('media-1', downloadFn);

    expect(downloadFn).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual(Buffer.from('downloaded'));
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('getOrDownload returns cached value on cache hit (download NOT called)', async () => {
    const cache = new MediaCache();
    cache.set('media-1', { data: Buffer.from('cached'), mimeType: 'image/png' });

    const downloadFn = mock(async () => ({
      data: Buffer.from('should not appear'),
      mimeType: 'image/jpeg',
    }));

    const result = await cache.getOrDownload('media-1', downloadFn);

    expect(downloadFn).not.toHaveBeenCalled();
    expect(result.data).toEqual(Buffer.from('cached'));
    expect(result.mimeType).toBe('image/png');
  });

  it('getOrDownload caches the download result', async () => {
    const cache = new MediaCache();
    const downloadFn = mock(async () => ({
      data: Buffer.from('fresh'),
      mimeType: 'image/gif',
      filename: 'anim.gif',
    }));

    await cache.getOrDownload('media-1', downloadFn);

    // Verify it was cached
    const cached = cache.get('media-1');
    expect(cached).toBeDefined();
    expect(cached!.data).toEqual(Buffer.from('fresh'));
    expect(cached!.mimeType).toBe('image/gif');
    expect(cached!.filename).toBe('anim.gif');
  });

  it('size returns current entry count', () => {
    const cache = new MediaCache();
    expect(cache.size).toBe(0);

    cache.set('a', { data: Buffer.from('a'), mimeType: 'text/plain' });
    expect(cache.size).toBe(1);

    cache.set('b', { data: Buffer.from('b'), mimeType: 'text/plain' });
    expect(cache.size).toBe(2);
  });

  it('clear removes all entries', () => {
    const cache = new MediaCache();
    cache.set('a', { data: Buffer.from('a'), mimeType: 'text/plain' });
    cache.set('b', { data: Buffer.from('b'), mimeType: 'text/plain' });

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('LRU refresh: accessing an entry moves it to the end so oldest non-accessed gets evicted first', () => {
    const cache = new MediaCache({ maxSize: 3 });

    cache.set('a', { data: Buffer.from('a'), mimeType: 'text/plain' });
    cache.set('b', { data: Buffer.from('b'), mimeType: 'text/plain' });
    cache.set('c', { data: Buffer.from('c'), mimeType: 'text/plain' });

    // Access 'a', making 'b' the oldest
    cache.get('a');

    // Add 'd' -- should evict 'b' (the oldest non-accessed)
    cache.set('d', { data: Buffer.from('d'), mimeType: 'text/plain' });

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
  });
});
