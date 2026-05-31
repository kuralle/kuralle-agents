import { z } from 'zod';
import type { Capability, ToolDeclaration, PromptSection, CapabilityAction } from './index.js';

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * Simplified retrieval interface for the capability layer.
 * Decoupled from AutoRetrieveProvider's RunContext requirement — the
 * capability system is backend-agnostic and has no RunContext at tool time.
 */
export interface RetrieveProvider {
  run: (opts: { input: string }) => Promise<{ text: string } | null>;
  label?: string;
}

export interface AutoRetrieveCapabilityConfig {
  provider: RetrieveProvider;
}

// ─── AutoRetrieveCapability ──────────────────────────────────────────────────

/**
 * Converts auto-retrieve from a pipeline stage to an on-demand
 * `search_knowledge_base` tool. The LLM decides when to call it;
 * the result flows back as a tool result for the LLM to use.
 */
export class AutoRetrieveCapability implements Capability {
  private provider: RetrieveProvider;

  constructor(config: AutoRetrieveCapabilityConfig) {
    this.provider = config.provider;
  }

  getTools(): ToolDeclaration[] {
    const label = this.provider.label ?? 'knowledge base';

    return [
      {
        name: 'search_knowledge_base',
        description: `Search the ${label} for relevant information to answer the user's question.`,
        parameters: z.object({
          query: z.string().describe('The search query'),
        }),
        execute: async (args: { query: string }) => {
          const result = await this.provider.run({ input: args.query });
          return result ?? { text: 'No relevant information found.' };
        },
      } as ToolDeclaration,
    ];
  }

  getPromptSections(): PromptSection[] {
    return [];
  }

  processToolResult(_toolName: string, _args: unknown, _result: unknown): CapabilityAction | null {
    return null;
  }
}
