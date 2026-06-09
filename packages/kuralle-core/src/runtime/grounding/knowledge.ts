import { z } from 'zod';
import type { AgentConfig } from '../../types/agentConfig.js';
import type { AutoRetrieveProvider, RunContext } from '../../types/run-context.js';
import type { HarnessStreamPart } from '../../types/stream.js';
import type { AnyTool } from '../../types/effectTool.js';
import type { AgentKnowledgeOverrides, KnowledgeProviderConfig } from '../../types/voice.js';
import { defineTool } from '../../tools/effect/defineTool.js';
import { normalizeCitations } from '../citations/index.js';
import { KnowledgeProvider } from '../KnowledgeProvider.js';

function latestUserMessage(ctx: RunContext): string {
  for (let index = ctx.runState.messages.length - 1; index >= 0; index -= 1) {
    const message = ctx.runState.messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

function formatRetrievalBlock(results: Array<{ text: string }>, maxChars: number): string | undefined {
  if (results.length === 0) {
    return undefined;
  }
  const body = results
    .map((result, index) => `[${index + 1}] ${result.text}`)
    .join('\n\n')
    .slice(0, maxChars);
  if (!body.trim()) {
    return undefined;
  }
  return `\n\n## Retrieved Knowledge\n${body}`;
}

export function buildKnowledgeProvider(config: KnowledgeProviderConfig): KnowledgeProvider {
  return new KnowledgeProvider({ config });
}

export function buildAutoRetrieveProvider(
  provider: KnowledgeProvider,
  agent: AgentConfig,
): AutoRetrieveProvider | undefined {
  if (!agent.knowledge) {
    return undefined;
  }
  if (agent.knowledge.autoRetrieve === false) {
    return undefined;
  }
  if (!provider.hasRetriever && !provider.hasCompiled) {
    return undefined;
  }

  const overrides = agent.knowledge as AgentKnowledgeOverrides;

  return {
    retrieve: async (ctx, scope) => {
      const query = scope?.query ?? latestUserMessage(ctx);
      const merged = scope?.knowledge ? { ...overrides, ...scope.knowledge } : overrides;
      const cache = undefined;
      const { results, events } = await provider.retrieve(
        query || ' ',
        cache,
        merged,
        false,
      );

      for (const event of events as HarnessStreamPart[]) {
        ctx.emit(event);
      }

      const compiled = provider.getCompiledKnowledge(merged);
      const retrievalResults = results.length > 0 ? results : [];
      const combined = [
        ...(compiled ? [{ text: compiled }] : []),
        ...retrievalResults.map((result) => ({ text: result.text })),
      ];

      const maxChars = provider.resolveConfig(merged).maxOutputTokens * 4;
      const block = formatRetrievalBlock(combined, maxChars);
      const citations = normalizeCitations(retrievalResults);
      if (!block && citations.length === 0) {
        return undefined;
      }
      return { block, citations: citations.length > 0 ? citations : undefined };
    },
  };
}

export function buildKnowledgeTool(
  provider: KnowledgeProvider,
  agent: AgentConfig,
): AnyTool | undefined {
  if (!agent.knowledge || agent.knowledge.autoRetrieve !== false) {
    return undefined;
  }
  if (!provider.hasRetriever && !provider.hasCompiled) {
    return undefined;
  }

  const overrides = agent.knowledge as AgentKnowledgeOverrides;

  return defineTool({
    name: 'knowledge_search',
    description:
      'Search the knowledge base for facts needed to answer the user. Call this whenever you need grounded information before answering. Returns relevant document snippets.',
    input: z.object({
      query: z
        .string()
        .trim()
        .min(1, 'Query must not be empty.')
        .describe("What to look up, in the user's language."),
    }),
    execute: async ({ query }, ctx) => {
      const { results, events } = await provider.retrieve(query, undefined, overrides, false);

      if (ctx?.emit) {
        for (const event of events) {
          ctx.emit(event as HarnessStreamPart);
        }
      }

      const compiled = provider.getCompiledKnowledge(overrides);
      return {
        documents: [
          ...(compiled ? [compiled] : []),
          ...results.map((result) => result.text),
        ],
      };
    },
  });
}

export function appendGatherBlocks(system: string, blocks: Array<string | undefined>): string {
  const extras = blocks.filter((block): block is string => Boolean(block?.trim()));
  if (extras.length === 0) {
    return system;
  }
  return system + extras.join('');
}
