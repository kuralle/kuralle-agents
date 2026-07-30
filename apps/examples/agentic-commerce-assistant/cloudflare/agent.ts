import { KuralleAgent, type HarnessConfig } from '@kuralle-agents/cf-agent';
import { PiDriver } from '@kuralle-agents/pi-driver';
import type { Matcher } from '@samesake/server';
import { buildCommerceAgent } from '../src/agent.js';
import { databaseUrl, requireEnv } from '../src/env.js';
import { createGatewayRuntime } from '../src/gateway.js';
import { createPorulleClient } from '../src/porulle.js';
import { createProductMatcher, createProductRetrieval } from '../src/search.js';
import type { Env } from './env.js';
import { SqlOrderLedger } from './order-ledger.js';

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
}
