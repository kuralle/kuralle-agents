/**
 * Bella's Italian Kitchen assistant -- CAG (Chunk and Generate) pattern.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import {
  createStaticKnowledgeSource,
  createLLMRetriever,
} from '@kuralle-agents/rag';
import { createCagTool } from '@kuralle-agents/tools';
import { wireTools } from '../_shared/runtime/v2Tools.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

const menuContent = readFileSync(
  join(currentDir, 'knowledge', 'menu.md'),
  'utf-8',
);

const menuSource = createStaticKnowledgeSource({
  id: 'menu',
  name: 'Restaurant Menu',
  description: 'Full menu with prices, allergens, and dietary info',
  content: menuContent,
});

function retrieverModel() {
  const googleKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (googleKey) {
    return createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.0-flash');
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY or OPENAI_API_KEY required');
  return createOpenAI({ apiKey: openaiKey })('gpt-4o-mini');
}

const menuRetriever = createLLMRetriever({
  model: retrieverModel(),
  topK: 6,
  includeReasons: true,
});

const searchMenuRaw = createCagTool({
  sources: [menuSource],
  retriever: menuRetriever,
  topK: 6,
});

const menuTools = wireTools({ search_menu: searchMenuRaw });

export function buildAgents(model: LanguageModel): AgentConfig[] {
  return [
    defineAgent({
      id: 'bella',
      name: "Bella's Assistant",
      model,
      instructions: [
        "You are the virtual assistant for Bella's Italian Kitchen.",
        'Use the search_menu tool to look up menu items, prices, allergens, and policies.',
        'Always cite prices from the menu — do not guess.',
        'If a customer has dietary restrictions, proactively mention relevant allergen info.',
        'Be warm and welcoming, like a friendly Italian host.',
      ].join(' '),
      tools: menuTools.tools,
      effectTools: menuTools.effectTools,
      knowledge: {},
    }),
  ];
}
