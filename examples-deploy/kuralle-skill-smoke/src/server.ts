import { routeAgentRequest } from 'agents';
import { KuralleAgent } from '@kuralle-agents/cf-agent';
import { createRuntime, defineAgent, defineTool, MemoryStore } from '@kuralle-agents/core';
import { defineSkill } from '@kuralle-agents/skills';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

interface Env {
  OPENAI_API_KEY: string;
  SkillAgent: DurableObjectNamespace;
}

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Fetch order status, items, and delivery date for an order id.',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({
    orderId,
    status: 'delivered',
    deliveredAt: '2026-05-01',
    daysSinceDelivery: 12,
    items: ['Wireless earbuds'],
  }),
});

const returnsPolicy = defineSkill({
  name: 'returns-policy',
  description:
    'Explains the 30-day return window, refund timelines, and exceptions. Use when the customer asks about returning, refunding, or exchanging an order.',
  allowedTools: ['lookup_order'],
  body: [
    '# Returns policy',
    '1. Confirm the order id, then run the `lookup_order` tool.',
    '2. If the order is fewer than 30 days old, it is returnable.',
    '3. State the refund timeline (5-7 business days to the original method).',
    '4. For gift cards or final-sale items, call read_skill_resource with exceptions.md.',
  ].join('\n'),
  resources: { 'exceptions.md': '# Non-returnable\n- Gift cards\n- Final-sale items' },
});

/**
 * Minimal deployable cf-agent that proves Skills (progressive disclosure via
 * `load_skill`) work on a real deployed Durable Object. Curl-able `/chat`.
 */
export class SkillAgent extends KuralleAgent<Env> {
  protected getAgents() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    return [
      defineAgent({
        id: 'support',
        model: openai('gpt-4o-mini'),
        instructions: 'You are a calm, precise support agent. Use skills and tools — never guess order facts.',
        tools: { lookup_order: lookupOrder },
        skills: [returnsPolicy],
        limits: { maxSteps: 8 },
      }),
    ];
  }

  protected getDefaultAgentId() {
    return 'support';
  }

  // GET /agents/skill-agent/<id>/chat?q=...
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/chat')) {
      const q =
        url.searchParams.get('q') ??
        'Can I return order A123? Load the returns-policy skill first, then lookup_order for A123, and tell me if it is returnable.';
      const runtime = createRuntime({
        agents: this.getAgents(),
        defaultAgentId: this.getDefaultAgentId(),
        sessionStore: new MemoryStore(),
      });
      const handle = runtime.run({ input: q, sessionId: 'skill-chat' });
      const toolCalls: string[] = [];
      let text = '';
      for await (const event of handle.events) {
        if (event.type === 'text-delta') text += event.delta;
        if (event.type === 'tool-call') toolCalls.push(event.toolName);
      }
      await handle;
      return Response.json({
        toolCalls,
        usedLoadSkill: toolCalls.includes('load_skill'),
        usedLookup: toolCalls.includes('lookup_order'),
        text,
      });
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
