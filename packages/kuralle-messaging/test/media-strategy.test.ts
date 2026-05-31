import { describe, it, expect } from 'bun:test';
import {
  HttpUrlStrategy,
  UploadStrategy,
  FileHashDedupStrategy,
} from '../src/shared/media-strategy.js';
import type { MediaPayload, MediaHandle } from '../src/types.js';

describe('HttpUrlStrategy', () => {
  const s = new HttpUrlStrategy();

  it('resolves http(s) URL payloads as url', async () => {
    const out = await s.resolve({
      type: 'image',
      data: 'https://example.com/a.jpg',
      mimeType: 'image/jpeg',
    });
    expect(out).toEqual({ kind: 'url', url: 'https://example.com/a.jpg', mimeType: 'image/jpeg' });
  });

  it('rejects non-URL string payloads', async () => {
    await expect(
      s.resolve({ type: 'image', data: 'not-a-url', mimeType: 'image/jpeg' }),
    ).rejects.toThrow('non-http(s)');
  });

  it('rejects Buffer payloads', async () => {
    await expect(
      s.resolve({ type: 'image', data: Buffer.from('x'), mimeType: 'image/jpeg' }),
    ).rejects.toThrow('URL string');
  });
});

describe('UploadStrategy', () => {
  it('invokes the uploader for Buffer payloads', async () => {
    const calls: Array<{ mimeType: string; filename?: string }> = [];
    const handle: MediaHandle = { mediaId: 'id-1', url: 'https://cdn/x' };
    const s = new UploadStrategy(async (_data, opts) => {
      calls.push(opts);
      return handle;
    });

    const out = await s.resolve({
      type: 'image',
      data: Buffer.from('bytes'),
      mimeType: 'image/png',
      filename: 'x.png',
    });

    expect(out).toEqual({ kind: 'handle', handle, mimeType: 'image/png' });
    expect(calls).toEqual([{ mimeType: 'image/png', filename: 'x.png' }]);
  });

  it('delegates to HttpUrlStrategy for URL payloads', async () => {
    const s = new UploadStrategy(async () => ({ mediaId: 'should-not-be-called' }));
    const out = await s.resolve({
      type: 'image',
      data: 'https://example.com/a.jpg',
      mimeType: 'image/jpeg',
    });
    expect(out.kind).toBe('url');
  });
});

describe('FileHashDedupStrategy', () => {
  it('returns cached handle on second identical Buffer', async () => {
    let uploadCalls = 0;
    const inner = {
      async resolve(payload: MediaPayload) {
        uploadCalls++;
        return {
          kind: 'handle' as const,
          handle: { mediaId: `id-${uploadCalls}` },
          mimeType: payload.mimeType,
        };
      },
    };
    const s = new FileHashDedupStrategy(inner);

    const buf = Buffer.from('identical content');
    const a = await s.resolve({ type: 'image', data: buf, mimeType: 'image/png' });
    const b = await s.resolve({ type: 'image', data: buf, mimeType: 'image/png' });

    expect(uploadCalls).toBe(1);
    if (a.kind === 'handle' && b.kind === 'handle') {
      expect(a.handle.mediaId).toBe(b.handle.mediaId);
    } else {
      throw new Error('expected handle results');
    }
  });

  it('uploads separately for different content', async () => {
    let uploadCalls = 0;
    const inner = {
      async resolve(payload: MediaPayload) {
        uploadCalls++;
        return {
          kind: 'handle' as const,
          handle: { mediaId: `id-${uploadCalls}` },
          mimeType: payload.mimeType,
        };
      },
    };
    const s = new FileHashDedupStrategy(inner);

    await s.resolve({ type: 'image', data: Buffer.from('a'), mimeType: 'image/png' });
    await s.resolve({ type: 'image', data: Buffer.from('b'), mimeType: 'image/png' });

    expect(uploadCalls).toBe(2);
  });

  it('skips dedup for non-Buffer (ReadableStream / URL) payloads', async () => {
    let uploadCalls = 0;
    const inner = {
      async resolve(_payload: MediaPayload) {
        uploadCalls++;
        return { kind: 'url' as const, url: 'https://example.com/x', mimeType: 'image/jpeg' };
      },
    };
    const s = new FileHashDedupStrategy(inner);

    await s.resolve({ type: 'image', data: 'https://example.com/x', mimeType: 'image/jpeg' });
    await s.resolve({ type: 'image', data: 'https://example.com/x', mimeType: 'image/jpeg' });

    expect(uploadCalls).toBe(2);
  });
});
