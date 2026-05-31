/**
 * AzureOpenAIRealtimeClient — Cloudflare-Workers-native Azure OpenAI Realtime.
 *
 * Endpoint: `<AZURE_ENDPOINT>/openai/realtime?api-version=<VER>&deployment=<DEP>`.
 * Auth: WS subprotocol list (Azure accepts the OpenAI-style subprotocol form
 * when an API key is passed; managed-identity/OAuth is a follow-up RFC).
 *
 * Session cap: 30 min (vs OpenAI's 60 min). Default `rolloverAfterMs` of
 * 25 min (from base) comfortably lands under both.
 */

import { OpenAIFamilyRealtimeClient, type OpenAIFamilyOptions } from './base.js';
import { azureProfile } from './protocol.js';

export interface AzureOpenAIRealtimeOptions extends OpenAIFamilyOptions {
  /** Azure endpoint like "https://my-resource.openai.azure.com" (no trailing slash). */
  endpoint: string;
  /** API version string like "2025-04-01-preview". */
  apiVersion: string;
  /** Deployment name for the realtime model. */
  deployment: string;
}

export class CloudflareAzureOpenAIRealtimeClient extends OpenAIFamilyRealtimeClient {
  constructor(opts: AzureOpenAIRealtimeOptions) {
    super(
      azureProfile({
        endpoint: opts.endpoint,
        apiVersion: opts.apiVersion,
        deployment: opts.deployment,
      }),
      opts,
    );
  }
}
