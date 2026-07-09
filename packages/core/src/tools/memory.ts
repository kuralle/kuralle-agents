import { tool } from 'ai';
import { z } from 'zod';

/**
 * Creates a tool that lets the agent search long-term memory.
 * The LLM decides when to call this based on the conversation.
 *
 * The tool accesses memoryService and session via experimental_context
 * injected by Runtime.wrapToolsWithEnforcement / withToolExecutionMetadata.
 *
 * Usage:
 *   const agent: AgentConfig = {
 *     tools: { ...otherTools, loadMemory: createLoadMemoryTool() },
 *   };
 */
export function createLoadMemoryTool() {
  return tool({
    description:
      'Search long-term memory for relevant information from past conversations with this user. ' +
      'Use this when the user refers to something discussed previously, or when you need context ' +
      'about their preferences, history, or past interactions.',
    inputSchema: z.object({
      query: z
        .string()
        .describe('What to search for in past conversations'),
    }),
    execute: async ({ query }, { experimental_context }) => {
      const ctx = experimental_context as Record<string, unknown> | undefined;
      const memoryService = ctx?.memoryService as { searchMemory: (req: { userId: string; query: string; limit?: number }) => Promise<{ memories: Array<{ content: string; author?: string; createdAt: Date }> }> } | undefined;
      const session = ctx?.session as { userId?: string } | undefined;
      const userId = session?.userId;

      if (!memoryService) {
        return { memories: [], note: 'Memory service not configured.' };
      }
      if (!userId) {
        return { memories: [], note: 'No userId on session.' };
      }

      const result = await memoryService.searchMemory({
        userId,
        query,
        limit: 10,
      });

      return {
        memories: result.memories.map((m) => ({
          content: m.content,
          author: m.author,
          date: m.createdAt.toISOString(),
        })),
      };
    },
  });
}
