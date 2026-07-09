import type { Chunker, KnowledgeSource, KnowledgeChunk } from './types.js';
import { createMarkdownChunker } from './chunkers.js';

export function createStaticKnowledgeSource(input: {
  id: string;
  name: string;
  description?: string;
  content: string;
  chunker?: Chunker;
  chunkOptions?: { maxChars?: number; overlapChars?: number };
}): KnowledgeSource {
  const chunker = input.chunker ?? createMarkdownChunker(input.chunkOptions);
  const chunks = chunker.chunk(input.content, input.chunkOptions);

  return {
    id: input.id,
    name: input.name,
    description: input.description,
    getChunks(): KnowledgeChunk[] {
      return chunks;
    },
    dumpContent(): string {
      return input.content;
    },
  };
}
