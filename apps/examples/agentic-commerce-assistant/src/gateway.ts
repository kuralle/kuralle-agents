import { createOpenAI } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { CommerceEnv } from './env.js';

const gatewayBase = (env: CommerceEnv) =>
  `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/${encodeURIComponent(env.CLOUDFLARE_GATEWAY_ID)}/openai`;

export function createGatewayFetch(token: string): typeof fetch {
  const gatewayFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    headers.delete('x-api-key');
    headers.set('cf-aig-authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  return gatewayFetch as typeof fetch;
}

export function createGatewayRuntime(env: CommerceEnv) {
  const modelId = env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const gatewayFetch = createGatewayFetch(env.CLOUDFLARE_API_KEY);
  const openai = createOpenAI({
    apiKey: 'gateway-managed',
    baseURL: gatewayBase(env),
    fetch: gatewayFetch,
  });

  const models = createModels();
  models.setProvider(cloudflareAIGatewayProvider());
  const piModel = models.getModel('cloudflare-ai-gateway', modelId);
  if (!piModel) throw new Error(`Pi did not register cloudflare-ai-gateway:${modelId}`);
  const streamFn: StreamFn = (model, context, options = {}) =>
    models.streamSimple(model, context, {
      ...options,
      env: {
        ...options.env,
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_GATEWAY_ID: env.CLOUDFLARE_GATEWAY_ID,
      },
    });

  return {
    controlModel: openai(modelId),
    piModel,
    models,
    streamFn,
    getApiKey: () => env.CLOUDFLARE_API_KEY,
  };
}

export async function embedThroughGateway(env: CommerceEnv, text: string, dimensions: number): Promise<number[]> {
  const response = await createGatewayFetch(env.CLOUDFLARE_API_KEY)(`${gatewayBase(env)}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      input: text,
      dimensions,
      encoding_format: 'float',
    }),
  });
  if (!response.ok) throw new Error(`AI Gateway embedding request failed (${response.status})`);
  const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = body.data?.[0]?.embedding;
  if (!vector || vector.length !== dimensions) {
    throw new Error(`Embedding response dimension mismatch: expected ${dimensions}, received ${vector?.length ?? 0}`);
  }
  return vector;
}
