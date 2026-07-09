// R2-backed BlobStore for large-file spillover from SqlFileSystem. Structural R2
// shape (no @cloudflare/workers-types dep). Zero `node:*` — Workers-clean.
import type { BlobStore } from './types.js';

export interface R2Bucketish {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, data: ArrayBuffer | Uint8Array): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export function r2BlobStore(bucket: R2Bucketish, opts?: { prefix?: string }): BlobStore {
  const prefix = opts?.prefix ?? '';
  const k = (key: string) => `${prefix}${key}`;
  return {
    async get(key) {
      const obj = await bucket.get(k(key));
      if (!obj) return null;
      return new Uint8Array(await obj.arrayBuffer());
    },
    async put(key, data) {
      await bucket.put(k(key), data);
    },
    async delete(key) {
      await bucket.delete(k(key));
    },
  };
}
