/**
 * Example: Multi-Agent Support System on Cloudflare
 *
 * Demonstrates:
 * - KuralleAgent extending CF's AIChatAgent
 * - Triage agent for intelligent routing
 * - Multiple specialist agents with tools
 * - Handoffs between agents
 *
 * Deploy:
 *   wrangler deploy
 */

/// <reference types="@cloudflare/workers-types" />

import { KuralleAgent } from '@kuralle-agents/cf-agent';
import type { HarnessConfig } from '@kuralle-agents/cf-agent';
import { createOpenAI } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';
import { wrapAiSdkTool } from '@kuralle-agents/core';
import { routeAgentRequest } from 'agents';

interface Env extends Cloudflare.Env {
  OPENAI_API_KEY: string;
  SupportAgent: DurableObjectNamespace;
}

export class SupportAgent extends KuralleAgent<Env> {
  protected getAgents(): HarnessConfig['agents'] {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const modelMini = openai('gpt-4o-mini');
    const model = openai('gpt-4o');

    const searchProducts = tool({
      description: 'Search the product catalog',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
      }),
      execute: async ({ query }) => ({
        query,
        results: [
          { name: 'Pro Plan', price: '$99/mo', features: 'Unlimited projects, 50GB, priority support' },
          { name: 'Enterprise', price: 'Custom', features: 'Everything in Pro + SSO, SLA, dedicated AM' },
        ],
      }),
    });

    const checkStatus = tool({
      description: 'Check service status',
      inputSchema: z.object({}),
      execute: async () => ({
        status: 'operational',
        services: {
          api: 'healthy',
          dashboard: 'healthy',
          webhooks: 'degraded - investigating',
        },
      }),
    });

    const lookupError = tool({
      description: 'Look up a known error code',
      inputSchema: z.object({
        code: z.string().describe('Error code (e.g., E-1234)'),
      }),
      execute: async ({ code }) => ({
        code,
        description: 'Rate limit exceeded',
        resolution: 'Wait 60 seconds or upgrade to Pro for higher limits.',
      }),
    });

    const processRefund = tool({
      description: 'Process a refund for an order',
      inputSchema: z.object({
        orderId: z.string().describe('The order ID'),
        amount: z.number().describe('Refund amount in dollars'),
        reason: z.string().describe('Reason for refund'),
      }),
      execute: async ({ orderId, amount, reason }) => ({
        success: true,
        refundId: `RF-${Date.now().toString(36)}`,
        orderId,
        amount,
        reason,
        estimatedDays: 5,
      }),
    });

    const salesAgent = {
      id: 'sales',
      name: 'Sales Specialist',
      model,
      instructions:
        'You are a knowledgeable sales specialist. Help customers understand products and pricing. Be friendly and helpful.',
      tools: { search_products: wrapAiSdkTool('search_products', searchProducts) },
      handoffs: ['technical', 'billing'],
    };

    const technicalAgent = {
      id: 'technical',
      name: 'Technical Support',
      model,
      instructions:
        'You are a technical support specialist. Help users troubleshoot issues and debug problems. Be patient and thorough.',
      tools: {
        check_status: wrapAiSdkTool('check_status', checkStatus),
        lookup_error: wrapAiSdkTool('lookup_error', lookupError),
      },
      handoffs: ['sales', 'billing'],
    };

    const billingAgent = {
      id: 'billing',
      name: 'Billing Support',
      model,
      instructions:
        'You are a billing support specialist. Help customers with payments, refunds, and invoices. Be understanding about billing concerns.',
      tools: { process_refund: wrapAiSdkTool('process_refund', processRefund) },
      handoffs: ['sales', 'technical'],
    };

    const triageAgent = {
      id: 'triage',
      name: 'Router',
      model: modelMini,
      instructions: 'Route conversations to the right specialist.',
      routes: [
        { agent: 'sales', when: 'Product questions, pricing, features, demos' },
        { agent: 'technical', when: 'Bugs, errors, API issues, integrations' },
        { agent: 'billing', when: 'Payments, refunds, invoices, subscriptions' },
      ],
      routing: { default: 'sales', mode: 'structured' as const },
      agents: [salesAgent, technicalAgent, billingAgent],
    };

    return [triageAgent, salesAgent, technicalAgent, billingAgent];
  }

  protected getDefaultAgentId() {
    return 'triage';
  }

  protected getStreamConfig() {
    return {
      includeHandoffs: true,
      includeFlowEvents: false,
      includeTripwires: true,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response('Not found', { status: 404 })
    );
  },
};
