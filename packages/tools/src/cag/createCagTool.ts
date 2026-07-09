import { createTool } from '@kuralle-agents/core';
import type { KnowledgeSource } from '@kuralle-agents/rag';
import { z } from 'zod';
import type { CagRetrieveTool, CagToolOptions, ChunkDef, RetrievalIndex } from './types.js';

export function createCagTool(options: CagToolOptions): CagRetrieveTool {
  const { sources, retriever, topK = 4 } = options;
  const index = buildChunkIndex(sources);

  return createTool({
    description: 'Retrieve relevant knowledge chunks.',
    inputSchema: z.object({
      query: z.string(),
      topK: z.number().optional(),
      hint: z.string().optional(),
    }),
    execute: async ({ query, topK: overrideK, hint }) => {
      const hits = await retriever.retrieve(query, sources, {
        topK: overrideK ?? topK,
        hint,
      });
      const chunks = mapHitsToChunks(hits, index);
      return { chunks };
    },
  });
}

function buildChunkIndex(sources: KnowledgeSource[]): Map<string, { text: string }>{
  const index = new Map<string, { text: string }>();
  for (const source of sources) {
    for (const chunk of source.getChunks()) {
      index.set(`${source.id}::${chunk.id}`, { text: chunk.text });
    }
  }
  return index;
}

function mapHitsToChunks(hits: { sourceId: string; chunkId: string; rank: number; score?: number; reason?: string }[], index: Map<string, { text: string }>): ChunkDef[] {
  const chunks: ChunkDef[] = [];
  for (const hit of hits) {
    const item = index.get(`${hit.sourceId}::${hit.chunkId}`);
    if (!item) continue;
    chunks.push({
      sourceId: hit.sourceId,
      chunkId: hit.chunkId,
      text: item.text,
      rank: hit.rank,
      score: hit.score,
      reason: hit.reason,
    });
  }
  return chunks;
}
