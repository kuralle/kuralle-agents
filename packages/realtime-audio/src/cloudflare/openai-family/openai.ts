/**
 * OpenAIRealtimeClient — Cloudflare-Workers-native OpenAI Realtime client.
 *
 * Model-locked endpoint: `wss://api.openai.com/v1/realtime?model=<model>`.
 * Auth: WS subprotocol list `['realtime', 'openai-insecure-api-key.<KEY>', ...]`.
 */

import { OpenAIFamilyRealtimeClient, type OpenAIFamilyOptions } from './base.js';
import { OPENAI_PROFILE } from './protocol.js';

export class CloudflareOpenAIRealtimeClient extends OpenAIFamilyRealtimeClient {
  constructor(opts: OpenAIFamilyOptions) {
    super(OPENAI_PROFILE, opts);
  }
}
