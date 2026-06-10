/**
 * Shared deterministic fixtures for the vecgrep-gap benchmarks.
 *
 * Everything here is seeded/deterministic so before/after runs measure the
 * same corpus with the same embedding geometry. Not published (files: dist).
 */
import type { Document, Embedder } from '../src/types.js';

// -- Deterministic PRNG -------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'order refund return shipping delivery warranty policy product catalog ' +
  'checkout payment invoice billing account support agent customer escalate ' +
  'exchange damaged tracking courier express standard international customs ' +
  'voucher discount loyalty subscription cancel renewal upgrade downgrade ' +
  'battery screen device repair replacement manual setup install configure ' +
  'network timeout latency retry queue session token expiry quota limit'
).split(' ');

// -- Corpus -------------------------------------------------------------------

export interface BenchCorpus {
  documents: Document[];
  /** Per-doc unique exact-match token, e.g. ref-code-D017. */
  refCodes: Map<string, string>;
}

export function makeCorpus(opts?: {
  docs?: number;
  sections?: number;
  wordsPerSection?: number;
  seed?: number;
}): BenchCorpus {
  const nDocs = opts?.docs ?? 200;
  const nSections = opts?.sections ?? 6;
  const nWords = opts?.wordsPerSection ?? 60;
  const rand = mulberry32(opts?.seed ?? 1337);

  const documents: Document[] = [];
  const refCodes = new Map<string, string>();

  for (let d = 0; d < nDocs; d++) {
    const docId = `doc-${String(d).padStart(3, '0')}`;
    const refCode = `ref-code-D${String(d).padStart(3, '0')}`;
    refCodes.set(docId, refCode);

    let text = `# Knowledge page ${docId}\n\n`;
    for (let s = 0; s < nSections; s++) {
      text += `## Section ${s} of ${docId}\n\n`;
      const words: string[] = [];
      for (let w = 0; w < nWords; w++) {
        words.push(WORDS[Math.floor(rand() * WORDS.length)]!);
      }
      // Plant the unique exact-match token in section 2 of every doc.
      if (s === 2) words.splice(5, 0, refCode);
      text += words.join(' ') + '.\n\n';
    }
    documents.push({
      id: docId,
      text,
      metadata: { page: `/kb/${docId}.md` },
    });
  }

  return { documents, refCodes };
}

// -- Deterministic embedder ---------------------------------------------------

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
 * provider-swap failure mode.
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
    const tokens = embTokens(text);
    for (const token of tokens) {
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

// -- Metrics helpers ----------------------------------------------------------

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export async function writeResults(name: string, data: unknown): Promise<void> {
  const dir = new URL('./results/', import.meta.url).pathname;
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}${name}.json`, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nresults written: bench/results/${name}.json`);
}
