import type { OnChatMessageOptions } from '@cloudflare/ai-chat';
import type { GenerateTextOnFinishCallback, ToolSet } from 'ai';
import { KuralleAgent, type HarnessConfig } from '@kuralle-agents/cf-agent';
import type { SignalActor } from '@kuralle-agents/core';
import { PiDriver } from '@kuralle-agents/pi-driver';
import type { Matcher } from '@samesake/server';
import { buildCommerceAgent } from '../src/agent.js';
import { databaseUrl, requireEnv } from '../src/env.js';
import { createGatewayRuntime } from '../src/gateway.js';
import { createPorulleClient } from '../src/porulle.js';
import { createProductMatcher, createProductRetrieval } from '../src/search.js';
import type { Env } from './env.js';
import { SqlOrderLedger } from './order-ledger.js';

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One coordination atom per shopper session: messages, cart, approvals, and effect journal. */
export class CommerceAgent extends KuralleAgent<Env> {
  private matcher?: Matcher;
  private gateway?: ReturnType<typeof createGatewayRuntime>;

  private services() {
    requireEnv(this.env);
    this.gateway ??= createGatewayRuntime(this.env);
    this.matcher ??= createProductMatcher(this.env, databaseUrl(this.env));
    const porulle = createPorulleClient({
      baseUrl: this.env.PORULLE_URL,
      apiKey: this.env.PORULLE_STOREFRONT_KEY,
    });
    return { gateway: this.gateway, matcher: this.matcher, porulle };
  }

  protected getAgents(): HarnessConfig['agents'] {
    const { gateway, matcher, porulle } = this.services();
    return [
      buildCommerceAgent({
        model: gateway.controlModel,
        env: this.env,
        retrieval: createProductRetrieval(matcher),
        porulle,
        ledger: new SqlOrderLedger(this.getSqlExecutor()),
      }),
    ];
  }

  protected getDefaultAgentId(): string {
    return 'shopping-assistant';
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/chat') || url.pathname.endsWith('/resume')) {
      const userId = request.headers.get('x-kuralle-user-id');
      if (!userId || !USER_ID_PATTERN.test(userId)) {
        return Response.json({ error: 'Authenticated internal identity is required.' }, { status: 401 });
      }
      if (!this.bindIdentity(userId)) {
        return Response.json({ error: 'Conversation identity mismatch.' }, { status: 403 });
      }
    }
    return super.onRequest(request);
  }

  async onChatMessage(
    onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response> {
    const userId = this.readIdentity();
    if (!userId) return Response.json({ error: 'Conversation identity is not bound.' }, { status: 401 });
    return super.onChatMessage(onFinish, {
      ...(options ?? { requestId: crypto.randomUUID() }),
      body: { ...options?.body, userId },
    });
  }

  protected async resolveSignalActor(): Promise<SignalActor | undefined> {
    const userId = this.readIdentity();
    return userId ? { id: userId, type: 'user' } : undefined;
  }

  protected getRuntimeConfig(): Partial<HarnessConfig> {
    const { gateway } = this.services();
    return {
      defaultModel: gateway.controlModel,
      driver: new PiDriver({
        model: gateway.piModel,
        models: gateway.models,
        streamFn: gateway.streamFn,
        getApiKey: gateway.getApiKey,
        maxSteps: 24,
      }),
      tracing: { enabled: true, sampling: 1 },
      compaction: { triggerTokens: 18_000, keepRecentMessages: 14 },
    };
  }

  private bindIdentity(userId: string): boolean {
    const sql = this.getSqlExecutor();
    sql`CREATE TABLE IF NOT EXISTS commerce_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      user_id TEXT NOT NULL
    )`;
    const current = this.readIdentity();
    if (current) return current === userId;
    sql`INSERT INTO commerce_identity (singleton, user_id) VALUES (1, ${userId})
      ON CONFLICT(singleton) DO NOTHING`;
    return this.readIdentity() === userId;
  }

  private readIdentity(): string | undefined {
    const rows = this.getSqlExecutor()< { user_id: string } >`SELECT user_id FROM commerce_identity WHERE singleton = 1`;
    return rows[0]?.user_id;
  }
}
