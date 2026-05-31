import type { ToolDefinition } from '@kuralle-agents/core';
import type { KnowledgeSource, KnowledgeRetriever, RetrievalHit } from '@kuralle-agents/rag';
import type { LanguageModel } from 'ai';

export type ChunkDef = {
  sourceId: string;
  chunkId: string;
  text: string;
  rank: number;
  score?: number;
  reason?: string;
};

export type CagRetrieveInput = {
  query: string;
  topK?: number;
  hint?: string;
};

export type CagRetrieveOutput = {
  chunks: ChunkDef[];
};

export type CagAnswerInput = {
  query: string;
  chunks: ChunkDef[];
};

export type CagAnswerOutput = {
  type: 'final';
  text: string;
  reasons?: string[];
  chunks: ChunkDef[];
};

export type CagToolOptions = {
  sources: KnowledgeSource[];
  retriever: KnowledgeRetriever;
  topK?: number;
};

export type CagAnswerToolOptions = {
  generatorModel: LanguageModel;
  prompt?: string;
};

export type CagRetrieveTool = ToolDefinition<CagRetrieveInput, CagRetrieveOutput>;
export type CagAnswerTool = ToolDefinition<CagAnswerInput, CagAnswerOutput>;

export type RetrievalIndex = {
  hits: RetrievalHit[];
  chunks: ChunkDef[];
};
