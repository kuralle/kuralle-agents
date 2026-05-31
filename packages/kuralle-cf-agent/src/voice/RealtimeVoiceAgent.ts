/**
 * KuralleRealtimeVoiceAgent — thin concrete class applying the
 * {@link withRealtimeVoice} mixin to {@link KuralleAgent}.
 *
 * Subclasses must either set `realtimeModel` to a constructed
 * {@link RealtimeAudioClient}, or override `createRealtimeModel(env)` so the
 * mixin can lazily build one (usually a `CloudflareGeminiLiveClient` with
 * `this.env.GEMINI_API_KEY`).
 *
 * @example
 * ```ts
 * import { CloudflareGeminiLiveClient } from "@kuralle-agents/realtime-audio";
 * import { KuralleRealtimeVoiceAgent } from "@kuralle-agents/cf-agent/voice";
 *
 * export class MyVoiceAgent extends KuralleRealtimeVoiceAgent<Env> {
 *   createRealtimeModel(env: Env) {
 *     return new CloudflareGeminiLiveClient({ apiKey: env.GEMINI_API_KEY });
 *   }
 *   protected getAgents() { return [{ id: "assistant", name: "Assistant", tools: {} }]; }
 *   protected getDefaultAgentId() { return "assistant"; }
 * }
 * ```
 */

import { KuralleAgent } from "../KuralleAgent.js";
import { withRealtimeVoice } from "./withRealtimeVoice.js";

const RealtimeVoiceKuralleAgentBase = withRealtimeVoice(KuralleAgent) as typeof KuralleAgent;

export abstract class KuralleRealtimeVoiceAgent<
  Env = unknown,
  State = unknown,
> extends RealtimeVoiceKuralleAgentBase<Env, State> {
  /**
   * Hibernate between calls; stay awake during active calls via `keepAlive()`.
   *
   * Reasoning:
   *   - Client WS uses the agents-SDK `Connection` abstraction (hibernation-
   *     aware), so a reconnect after eviction lands on a rehydrated DO with
   *     `this.messages` + `this.state` restored from SQLite.
   *   - Outbound provider WS is not hibernation-aware, but `keepAlive()`
   *     is held for the duration of a call → no eviction during calls.
   *   - On `end_call` / teardown we close the outbound cleanly, then release
   *     keepAlive → DO can safely hibernate (free) between calls.
   *
   * Contrast: `cloudflare/agents/openai-sdk/call-my-agent` sets
   * `hibernate: false` because its `TwilioRealtimeTransportLayer` attaches
   * raw `.addEventListener` handlers bypassing the hibernation path — that
   * doesn't apply to us.
   */
  static options = { hibernate: true };
}
