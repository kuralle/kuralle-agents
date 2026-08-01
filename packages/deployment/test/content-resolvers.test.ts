import { describe, expect, it } from 'bun:test';
import { r2ArtifactContentResolver } from '../src/cloudflare.js';
import { embeddedArtifactContentResolver, sha256 } from '../src/index.js';

describe('artifact content resolvers', () => {
  it('resolves strict content-addressed refs from embedded build bytes', async () => {
    const bytes = new TextEncoder().encode('large reference');
    const ref = `sha256:${await sha256(bytes)}`;
    const encoded = btoa(String.fromCharCode(...bytes));
    const resolver = embeddedArtifactContentResolver({ [ref]: encoded });

    expect(new TextDecoder().decode(await resolver.read(ref) as Uint8Array)).toBe('large reference');
    await expect(resolver.read('file:///etc/passwd')).rejects.toMatchObject({ code: 'CONTENT_INVALID' });
  });

  it('maps only a validated digest into the configured R2 prefix', async () => {
    const bytes = new TextEncoder().encode('blob');
    const digest = await sha256(bytes);
    const keys: string[] = [];
    const resolver = r2ArtifactContentResolver({
      async get(key) {
        keys.push(key);
        return { arrayBuffer: async () => bytes.slice().buffer };
      },
    }, { prefix: 'tenant-artifacts/' });

    expect(new TextDecoder().decode(await resolver.read(`sha256:${digest}`) as Uint8Array)).toBe('blob');
    expect(keys).toEqual([`tenant-artifacts/${digest}`]);
  });
});
