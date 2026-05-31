import type { AgentConfig } from '../../types/agentConfig.js';
import type { AutoRetrieveProvider, RunContext } from '../../types/run-context.js';
import type { HarnessStreamPart } from '../../types/stream.js';
import type { AgentKnowledgeOverrides, KnowledgeProviderConfig } from '../../types/voice.js';
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
  const maxOutputTokens = provider.resolveConfig(overrides).maxOutputTokens;

  return {
    retrieve: async (ctx) => {
      const query = latestUserMessage(ctx);
      const cache = undefined;
      const { results, events } = await provider.retrieve(
        query || ' ',
        cache,
        overrides,
        false,
      );

      for (const event of events as HarnessStreamPart[]) {
        ctx.emit(event);
      }

      const compiled = provider.getCompiledKnowledge(overrides);
      const retrievalResults = results.length > 0 ? results : [];
      const combined = [
        ...(compiled ? [{ text: compiled }] : []),
        ...retrievalResults.map((result) => ({ text: result.text })),
      ];

      return formatRetrievalBlock(combined, maxOutputTokens * 4);
    },
  };
}

export function appendGatherBlocks(system: string, blocks: Array<string | undefined>): string {
  const extras = blocks.filter((block): block is string => Boolean(block?.trim()));
  if (extras.length === 0) {
    return system;
  }
  return system + extras.join('');
}
