/**
 * Acme Corp support agent with vector RAG retrieval.
 */

import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { createVectorRetrievalTool } from '@kuralle-agents/tools';
import { wireTools } from '../_shared/runtime/v2Tools.js';
import { ragPipeline } from './rag.js';

import type { ToolDefinition } from '@kuralle-agents/core';

const searchRaw = createVectorRetrievalTool({
  retriever: ragPipeline,
  topK: 8,
  enableAgenticFilters: true,
  filterableFields: [
    {
      field: 'category',
      description: 'Document category',
      type: 'string',
      examples: ['policy', 'product'],
    },
  ],
});

const searchTools = wireTools({
  search_knowledge: searchRaw as unknown as ToolDefinition,
});

export function buildAgents(model: LanguageModel): AgentConfig[] {
  return [
    defineAgent({
      id: 'support',
      name: 'Acme Support Agent',
      model,
      instructions: [
        'You are a customer support agent for Acme Corp.',
        'Use the search_knowledge tool to look up policies, products, and FAQs before answering factual questions.',
        'Always ground your answers in the retrieved content — do not make up information.',
        'If the knowledge base does not contain an answer, say so honestly.',
        'Be concise and helpful.',
      ].join(' '),
      tools: searchTools.tools,
      knowledge: {},
    }),
  ];
}
