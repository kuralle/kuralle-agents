import { createTool } from '@kuralle-agents/core';
import { generateText } from 'ai';
import { z } from 'zod';
import type { CagAnswerTool, CagAnswerToolOptions } from './types.js';

export function createCagAnswerTool(options: CagAnswerToolOptions): CagAnswerTool {
  const {
    generatorModel,
    prompt: systemPrompt = 'Answer only using the provided context. If insufficient, say so.',
  } = options;

  return createTool({
    description: 'Generate a final answer using retrieved chunks.',
    inputSchema: z.object({
      query: z.string(),
      chunks: z.array(
        z.object({
          sourceId: z.string(),
          chunkId: z.string(),
          text: z.string(),
          rank: z.number(),
          score: z.number().optional(),
          reason: z.string().optional(),
        })
      ),
    }),
    execute: async ({ query, chunks }) => {
      const context = chunks.length
        ? `\n\n# Context\n${chunks.map(chunk => chunk.text).join('\n\n')}`
        : '';

      const { text } = await generateText({
        model: generatorModel,
        system: `${systemPrompt}${context}`,
        prompt: query,
      });

      return {
        type: 'final',
        text,
        reasons: chunks.map(chunk => chunk.reason).filter(Boolean) as string[],
        chunks,
      };
    },
  });
}
