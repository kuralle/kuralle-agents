import type { OnChatMessageOptions } from '@cloudflare/ai-chat';
import type { StreamTextOnFinishCallback, ToolSet } from 'ai';
import { KuralleAgent, SqlTraceStore, type HarnessConfig } from '@kuralle-agents/cf-agent';
import type { SignalActor } from '@kuralle-agents/core';
import { supportBackendFromEnv, type SupportBackend } from '../src/backend';
import { buildSupportRuntimeParts } from '../src/runtime';

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SupportEnv extends Cloudflare.Env {
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  SUPPORT_IDENTITY_SECRET: string;
  SUPPORT_API_URL?: string;
  SUPPORT_API_TOKEN?: string;
  SUPPORT_DEMO_MODE?: string;
  ENVIRONMENT: string;
  ALLOWED_ORIGINS?: string;
  SupportAgent: DurableObjectNamespace<SupportAgent>;
}

/** One authenticated support conversation, one single-writer durable object. */
export class SupportAgent extends KuralleAgent<SupportEnv> {
  private backendInstance?: SupportBackend;
  private runtimeParts?: ReturnType<typeof buildSupportRuntimeParts>;

  protected getAgents(): HarnessConfig['agents'] {
    return [this.parts().agent];
  }

  protected getDefaultAgentId(): string {
    return 'customer-support';
  }

  protected getRuntimeConfig(): Partial<HarnessConfig> {
    return this.parts().config;
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/chat') || url.pathname.endsWith('/resume')) {
      const userId = request.headers.get('x-kuralle-user-id');
      if (!userId || !USER_ID_PATTERN.test(userId)) {
        return Response.json({ error: 'Authenticated internal identity is required.' }, { status: 401 });
      }
      const bound = this.bindIdentity(userId);
      if (!bound) return Response.json({ error: 'Conversation identity mismatch.' }, { status: 403 });
    }
    return super.onRequest(request);
  }

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
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

  private backend(): SupportBackend {
    this.backendInstance ??= supportBackendFromEnv({
      SUPPORT_DEMO_MODE: this.env.SUPPORT_DEMO_MODE,
      SUPPORT_API_URL: this.env.SUPPORT_API_URL,
      SUPPORT_API_TOKEN: this.env.SUPPORT_API_TOKEN,
      production: this.env.ENVIRONMENT !== 'development',
    });
    return this.backendInstance;
  }

  private parts(): ReturnType<typeof buildSupportRuntimeParts> {
    this.runtimeParts ??= buildSupportRuntimeParts({
      apiKey: this.env.OPENAI_API_KEY,
      modelId: this.env.OPENAI_MODEL || 'gpt-4.1-mini',
      backend: this.backend(),
      traceStore: new SqlTraceStore(this.getSqlExecutor()),
    });
    return this.runtimeParts;
  }

  private bindIdentity(userId: string): boolean {
    const sql = this.getSqlExecutor();
    sql`CREATE TABLE IF NOT EXISTS support_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      user_id TEXT NOT NULL
    )`;
    const current = this.readIdentity();
    if (current) return current === userId;
    sql`INSERT INTO support_identity (singleton, user_id) VALUES (1, ${userId})
      ON CONFLICT(singleton) DO NOTHING`;
    return this.readIdentity() === userId;
  }

  private readIdentity(): string | undefined {
    const rows = this.getSqlExecutor()< { user_id: string } >`SELECT user_id FROM support_identity WHERE singleton = 1`;
    return rows[0]?.user_id;
  }
}
