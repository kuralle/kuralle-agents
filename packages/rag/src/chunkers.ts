import type { Chunker, ChunkOptions, KnowledgeChunk, TokenCounter, TokenChunkOptions } from './types.js';

export function createMarkdownChunker(defaultOptions: ChunkOptions = {}): Chunker {
  return {
    chunk(text: string, options?: ChunkOptions): KnowledgeChunk[] {
      const merged = { ...defaultOptions, ...options };
      const sections = parseMarkdownSections(text);
      const chunks: KnowledgeChunk[] = [];
      const seen = new Map<string, number>();

      for (const section of sections) {
        const baseId = section.id;
        const count = (seen.get(baseId) ?? 0) + 1;
        seen.set(baseId, count);
        const id = count > 1 ? `${baseId} (${count})` : baseId;
        const parts = splitByMaxChars(section.text, merged.maxChars, merged.overlapChars);
        if (parts.length === 1) {
          chunks.push({ id, text: parts[0] });
          continue;
        }
        for (let i = 0; i < parts.length; i++) {
          chunks.push({ id: `${id}#${i + 1}`, text: parts[i] });
        }
      }

      return chunks;
    },
  };
}

export function createRecursiveChunker(defaultOptions: ChunkOptions = {}): Chunker {
  return {
    chunk(text: string, options?: ChunkOptions): KnowledgeChunk[] {
      const merged = { ...defaultOptions, ...options };
      const parts = splitByMaxChars(text, merged.maxChars, merged.overlapChars);
      return parts.map((part, index) => ({ id: `chunk-${index + 1}`, text: part }));
    },
  };
}

function parseMarkdownSections(content: string): KnowledgeChunk[] {
  const lines = content.split(/\r?\n/);
  const sections: KnowledgeChunk[] = [];

  let currentId: string | null = null;
  let buffer: string[] = [];
  let firstHeadingUsed = false;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    const hN = line.match(/^#{2,6}\s+(.+)$/);

    if (h1 && !firstHeadingUsed && buffer.length === 0 && !currentId) {
      firstHeadingUsed = true;
      continue;
    }

    if (hN) {
      if (currentId || buffer.length > 0) {
        sections.push({ id: currentId ?? 'section', text: buffer.join('\n').trim() });
      }
      currentId = hN[1].trim();
      buffer = [];
      continue;
    }

    buffer.push(line);
  }

  if (currentId || buffer.length > 0) {
    sections.push({ id: currentId ?? 'section', text: buffer.join('\n').trim() });
  }

  return sections.filter(section => section.text.length > 0);
}

function splitByMaxChars(text: string, maxChars?: number, overlapChars: number = 0): string[] {
  if (!maxChars || text.length <= maxChars) {
    return [text];
  }

  const step = Math.max(1, maxChars - overlapChars);
  const parts: string[] = [];

  for (let start = 0; start < text.length; start += step) {
    const end = Math.min(text.length, start + maxChars);
    parts.push(text.slice(start, end));
    if (end === text.length) break;
  }

  return parts;
}

// ---------------------------------------------------------------------------
// Token-aware chunker
// ---------------------------------------------------------------------------

/** Default character-based token estimator (~4 chars per token). */
const DEFAULT_TOKEN_COUNTER: TokenCounter = (text: string) => Math.ceil(text.length / 4);

export interface TokenChunkerConfig {
  /**
   * Token counting function. Implementations may use js-tiktoken,
   * gpt-tokenizer, or any other tokenizer library.
   *
   * When not provided, falls back to character-based estimation
   * (~4 characters per token). This fallback is suitable for
   * Cloudflare Workers and other runtimes where WASM-based
   * tokenizers are not available.
   */
  countTokens?: TokenCounter;
  /** Default options applied when not overridden per-call. */
  defaults?: TokenChunkOptions;
}

/**
 * Creates a token-aware chunker that splits text by token count.
 *
 * Splits on sentence boundaries (. ! ? followed by whitespace) when
 * possible to produce more natural chunk boundaries. Falls back to
 * word boundaries, then character boundaries if sentences exceed the
 * token limit.
 *
 * Accepts a pluggable token counter function — use js-tiktoken for
 * accurate GPT-family counting, gpt-tokenizer for a lighter alternative,
 * or omit for a character-based (~4 chars/token) fallback.
 */
export function createTokenChunker(config: TokenChunkerConfig = {}): Chunker {
  const countTokens = config.countTokens ?? DEFAULT_TOKEN_COUNTER;
  const defaultMaxTokens = config.defaults?.maxTokens ?? 512;
  const defaultOverlapTokens = config.defaults?.overlapTokens ?? 0;

  return {
    chunk(text: string, options?: ChunkOptions): KnowledgeChunk[] {
      // Read token-denominated options directly. The legacy conflation
      // (maxChars -> maxTokens, overlapChars -> overlapTokens) is GONE:
      // the per-call shape now exposes maxTokens/overlapTokens as first-class
      // fields on ChunkOptions, and createTokenChunker only reads those.
      // Callers that still pass maxChars/overlapChars to a token chunker
      // fall through to the chunker's configured defaults.
      const maxTokens = options?.maxTokens ?? defaultMaxTokens;
      const overlapTokens = options?.overlapTokens ?? defaultOverlapTokens;

      const totalTokens = countTokens(text);
      if (totalTokens <= maxTokens) {
        return [{ id: 'chunk-1', text, tokens: totalTokens }];
      }

      const sentences = splitIntoSentences(text);
      const chunks: KnowledgeChunk[] = [];
      let currentSentences: string[] = [];
      let currentTokens = 0;
      let chunkIndex = 0;

      for (const sentence of sentences) {
        const sentenceTokens = countTokens(sentence);

        // If a single sentence exceeds the limit, split it by words
        if (sentenceTokens > maxTokens) {
          // Flush current buffer first
          if (currentSentences.length > 0) {
            chunkIndex++;
            const chunkText = currentSentences.join(' ');
            chunks.push({
              id: `chunk-${chunkIndex}`,
              text: chunkText,
              tokens: currentTokens,
            });
            currentSentences = handleOverlap(currentSentences, overlapTokens, countTokens);
            currentTokens = currentSentences.length > 0 ? countTokens(currentSentences.join(' ')) : 0;
          }

          // Split the oversized sentence by words
          const wordChunks = splitByWords(sentence, maxTokens, overlapTokens, countTokens);
          for (const wc of wordChunks) {
            chunkIndex++;
            chunks.push({
              id: `chunk-${chunkIndex}`,
              text: wc.text,
              tokens: wc.tokens,
            });
          }
          continue;
        }

        if (currentTokens + sentenceTokens > maxTokens && currentSentences.length > 0) {
          // Flush current chunk
          chunkIndex++;
          const chunkText = currentSentences.join(' ');
          chunks.push({
            id: `chunk-${chunkIndex}`,
            text: chunkText,
            tokens: currentTokens,
          });

          // Handle overlap: keep trailing sentences that fit within overlap budget
          currentSentences = handleOverlap(currentSentences, overlapTokens, countTokens);
          currentTokens = currentSentences.length > 0 ? countTokens(currentSentences.join(' ')) : 0;
        }

        currentSentences.push(sentence);
        currentTokens += sentenceTokens;
      }

      // Flush remaining
      if (currentSentences.length > 0) {
        chunkIndex++;
        const chunkText = currentSentences.join(' ');
        chunks.push({
          id: `chunk-${chunkIndex}`,
          text: chunkText,
          tokens: countTokens(chunkText),
        });
      }

      return chunks;
    },
  };
}

function splitIntoSentences(text: string): string[] {
  // Split on sentence boundaries: period, exclamation, question mark
  // followed by whitespace or end of string.
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.filter(p => p.length > 0);
}

function handleOverlap(
  sentences: string[],
  overlapTokens: number,
  countTokens: TokenCounter,
): string[] {
  if (overlapTokens <= 0 || sentences.length === 0) return [];

  const overlap: string[] = [];
  let tokens = 0;

  // Walk backwards from end to collect overlap sentences
  for (let i = sentences.length - 1; i >= 0; i--) {
    const st = countTokens(sentences[i]);
    if (tokens + st > overlapTokens) break;
    overlap.unshift(sentences[i]);
    tokens += st;
  }

  return overlap;
}

function splitByWords(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  countTokens: TokenCounter,
): Array<{ text: string; tokens: number }> {
  const words = text.split(/\s+/);
  const chunks: Array<{ text: string; tokens: number }> = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const word of words) {
    const wordTokens = countTokens(word);
    if (currentTokens + wordTokens > maxTokens && current.length > 0) {
      const chunkText = current.join(' ');
      chunks.push({ text: chunkText, tokens: currentTokens });

      // Overlap handling for word-level splits
      if (overlapTokens > 0) {
        const overlap: string[] = [];
        let ot = 0;
        for (let i = current.length - 1; i >= 0; i--) {
          const wt = countTokens(current[i]);
          if (ot + wt > overlapTokens) break;
          overlap.unshift(current[i]);
          ot += wt;
        }
        current = overlap;
        currentTokens = ot;
      } else {
        current = [];
        currentTokens = 0;
      }
    }
    current.push(word);
    currentTokens += wordTokens;
  }

  if (current.length > 0) {
    chunks.push({ text: current.join(' '), tokens: currentTokens });
  }

  return chunks;
}
