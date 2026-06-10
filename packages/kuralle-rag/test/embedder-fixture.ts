/**
 * Deterministic embedder fixtures shared by tests and bench/.
 */
import type { Embedder } from '../src/types.js';

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function embTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Deterministic bag-of-hashed-tokens embedder. Two instances with the same
 * `seed` produce identical vector spaces; different seeds produce
 * incompatible spaces of the SAME dimension — exactly the silent
 * provider-swap failure mode the ingest-manifest lock exists to catch.
 */
export class HashEmbedder implements Embedder {
  readonly dimension: number;
  readonly id: string;
  private readonly seed: string;

  constructor(opts?: { dimension?: number; seed?: string }) {
    this.dimension = opts?.dimension ?? 256;
    this.seed = opts?.seed ?? 'model-a';
    this.id = `bench/hash-embedder-${this.seed}`;
  }

  private embedSync(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    for (const token of embTokens(text)) {
      vec[fnv1a(`${this.seed}:${token}`) % this.dimension] += 1;
      // bigram smoothing for slightly less brittle similarity
      for (let i = 0; i + 1 < token.length; i += 2) {
        vec[fnv1a(`${this.seed}:${token.slice(i, i + 2)}`) % this.dimension] += 0.25;
      }
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  async embed(text: string): Promise<readonly number[]> {
    return this.embedSync(text);
  }

  async embedMany(texts: string[]): Promise<readonly (readonly number[])[]> {
    return texts.map((t) => this.embedSync(t));
  }
}

/** Wraps an embedder and counts how many texts get embedded. */
export class CountingEmbedder implements Embedder {
  embedCalls = 0;
  textsEmbedded = 0;

  constructor(private readonly inner: Embedder) {}

  get dimension(): number | undefined {
    return this.inner.dimension;
  }

  get id(): string | undefined {
    return this.inner.id;
  }

  async embed(text: string): Promise<readonly number[]> {
    this.embedCalls += 1;
    this.textsEmbedded += 1;
    return this.inner.embed(text);
  }

  async embedMany(texts: string[]): Promise<readonly (readonly number[])[]> {
    this.embedCalls += 1;
    this.textsEmbedded += texts.length;
    return this.inner.embedMany(texts);
  }

  reset(): void {
    this.embedCalls = 0;
    this.textsEmbedded = 0;
  }
}
