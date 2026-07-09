import type { Context, Hono } from 'hono';
import { AgentHandler, type AgentHandlerOptions } from '../handler.js';

/**
 * Mount the agent handler on a Hono app.
 *
 * Creates two routes:
 *   GET  <path>  -- SSE stream
 *   POST <path>  -- User input
 *
 * Usage:
 *   import { Hono } from 'hono';
 *   import { mountAgent } from '@kuralle-agents/livekit-plugin-transport-http/hono';
 *   import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
 *   import { Runtime } from '@kuralle-agents/core';
 *   import { openai } from '@ai-sdk/openai';
 *   import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
 *
 *   const app = new Hono();
 *
 *   const runtime = new Runtime({
 *     agents: [{
 *       id: 'assistant',
 *       name: 'Assistant',
 *       model: openai('gpt-4o-mini'),
 *       prompt: 'You are helpful.',
 *     }],
 *     defaultAgentId: 'assistant',
 *     defaultModel: openai('gpt-4o-mini'),
 *   });
 *
 *   mountAgent(app, '/voice', {
 *     agent: () => new KuralleVoiceSession({
 *       runtime: runtime,
 *       stt: new GeminiLiveSTT(),
 *       tts: new GeminiLiveTTS(),
 *       greeting: 'Hello!',
 *     }),
 *   });
 */
export function mountAgent(
  app: Hono,
  path: string,
  options: AgentHandlerOptions,
): AgentHandler {
  const handler = new AgentHandler(options);

  app.get(path, async (c: Context) => {
    const response = await handler.handleSSE(c.req.raw);
    return response;
  });

  app.post(path, async (c: Context) => {
    const response = await handler.handleInput(c.req.raw);
    return response;
  });

  return handler;
}
