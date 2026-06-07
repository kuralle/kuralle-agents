import { routeAgentRequest } from 'agents';
import { KuralleAgent, type SqlPersistentMemoryStore } from '@kuralle-agents/cf-agent';
import { defineAgent, createRuntime, MemoryStore } from '@kuralle-agents/core';
import { createOpenAI } from '@ai-sdk/openai';

interface Env {
  OPENAI_API_KEY: string;
  MemoryAgent: DurableObjectNamespace;
}

/**
 * Minimal deployable cf-agent that proves working memory persists in the
 * Durable Object's SQLite across requests. Adds a curl-able `/chat` endpoint.
 */
export class MemoryAgent extends KuralleAgent<Env> {
  protected getAgents() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    return [
      defineAgent({
        id: 'mem',
        model: openai('gpt-4o-mini'),
        // NEUTRAL — the framework's working-memory directive drives storage.
        instructions: 'You are a friendly assistant. Be concise.',
        memory: { workingMemory: { autoLoad: [{ scope: 'user', key: 'USER' }] } }, // store auto-wired to DO SQLite
      }),
    ];
  }

  protected getDefaultAgentId() {
    return 'mem';
  }

  // GET /agents/memory-agent/<sessionId>/chat?userId=U&q=...
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/chat')) {
      const userId = url.searchParams.get('userId') ?? 'anon';
      const q = url.searchParams.get('q') ?? '';
      const wmStore = this.getWorkingMemoryStore() as SqlPersistentMemoryStore;
      const runtime = createRuntime({
        agents: this.getAgents(),
        defaultAgentId: this.getDefaultAgentId(),
        sessionStore: new MemoryStore(),
        defaultWorkingMemoryStore: wmStore,
      });
      const result = await runtime.run({ input: q, sessionId: 'chat', userId });
      const block = await wmStore.loadBlock('user', userId, 'USER');
      return Response.json({ text: result.text ?? '', userBlock: block?.content ?? null });
    }
    return super.onRequest(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env, { cors: true });
    return routed ?? new Response('not found', { status: 404 });
  },
};
