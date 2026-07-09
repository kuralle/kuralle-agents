import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const distG711 = join(import.meta.dir, '..', 'dist', 'codec', 'g711.js');
const hasDist = existsSync(distG711);

describe.skipIf(!hasDist)('G.711 codec — compiled dist import shape', () => {
  // Guards against a resolver/interop regression where
  // `import * as mulaw from 'alawmulaw/lib/mulaw.js'` in the compiled dist
  // yielded a namespace where `mulaw.encode` was undefined — RTP send path
  // then crashed with `TypeError: mulaw.encode is not a function`.
  // See regression-issues/bug-livekit-g711-mulaw-encode.md.
  it('PCMU.encode and PCMA.encode resolve to callable functions via dist', async () => {
    const mod = await import(distG711);
    expect(typeof mod.PCMU.encode).toBe('function');
    expect(typeof mod.PCMA.encode).toBe('function');
    expect(typeof mod.PCMU.decode).toBe('function');
    expect(typeof mod.PCMA.decode).toBe('function');
  });

  it('PCMU.encode via dist returns a non-empty Uint8Array for a representative buffer', async () => {
    const { PCMU } = await import(distG711);
    const input = new Int16Array([0, 1, -1, 32767, -32768]);
    const out = PCMU.encode(input);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(input.length);
  });

  it('PCMA.encode via dist returns a non-empty Uint8Array for a representative buffer', async () => {
    const { PCMA } = await import(distG711);
    const input = new Int16Array([0, 1, -1, 32767, -32768]);
    const out = PCMA.encode(input);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(input.length);
  });
});
