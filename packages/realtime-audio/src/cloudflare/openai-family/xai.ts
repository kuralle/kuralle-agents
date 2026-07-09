/**
 * XAIGrokRealtimeClient — Cloudflare-Workers-native xAI Grok Voice client.
 *
 * Model-locked endpoint: `wss://api.x.ai/v1/realtime?model=<model>`.
 * Default model: `grok-4-1-fast-non-reasoning`. Default voice: `ara`.
 * Default VAD: `server_vad` (differs from OpenAI's `semantic_vad` default).
 * Auth: WS subprotocol list (same OpenAI-compatible shape).
 *
 * xAI's Voice API is OpenAI-protocol-compatible — LiveKit's xAI plugin is
 * a 42-line subclass of OpenAIRealtimeModel. We use composition instead of
 * inheritance so a future GA schema change in OpenAI doesn't silently break
 * xAI (per the OpenAI-family provider split).
 */

import { OpenAIFamilyRealtimeClient, type OpenAIFamilyOptions } from './base.js';
import { XAI_PROFILE } from './protocol.js';

export class CloudflareXAIGrokRealtimeClient extends OpenAIFamilyRealtimeClient {
  constructor(opts: OpenAIFamilyOptions) {
    super(XAI_PROFILE, opts);
  }
}
