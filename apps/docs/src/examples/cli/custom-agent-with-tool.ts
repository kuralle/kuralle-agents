import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { defineAgent, defineTool } from '@kuralle-agents/core';

// A durable effect tool — the model can call it, and you'll see `⚙ tool get_weather`
// in the `--trace` panel with its result and per-turn token counts.
const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city. Call this for any weather question.',
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 21, sky: 'clear', humidity: '48%' }),
});

// Bare agent — the CLI owns createRuntime, the session store, readState, and label.
export default defineAgent({
  id: 'assistant',
  instructions:
    'You are Aria, a concise and friendly assistant. Use get_weather for weather questions. ' +
    'Keep replies to one or two sentences.',
  model: openai('gpt-4o-mini'),
  tools: { get_weather: getWeather },
});
