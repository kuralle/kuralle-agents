/**
 * Kuralle realtime voice agent on Cloudflare — OpenAI / xAI Grok dual-provider.
 *
 * Pairs `KuralleRealtimeVoiceAgent` with `CloudflareOpenAIRealtimeClient` or
 * `CloudflareXAIGrokRealtimeClient`. The Durable Object handles audio
 * passthrough, tool dispatch, transcript persistence, chat_ctx mirror, and
 * proactive rollover; the Worker's `fetch` handler routes browser connections
 * via the `agents` SDK's `routeAgentRequest` helper, falling back to the
 * Vite-built static client assets.
 *
 * Pick the provider via the PROVIDER env var (default: "openai"). Required
 * secrets:
 *   - PROVIDER=openai → OPENAI_API_KEY (model pinned to gpt-realtime-1.5)
 *   - PROVIDER=xai    → XAI_API_KEY
 */

import { KuralleRealtimeVoiceAgent } from "@kuralle-agents/cf-agent/voice";
import {
  CloudflareOpenAIRealtimeClient,
  CloudflareXAIGrokRealtimeClient,
} from "@kuralle-agents/realtime-audio";
import { routeAgentRequest } from "agents";
import { tool } from "ai";
import { z } from "zod";

export interface Env {
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
  PROVIDER?: "openai" | "xai";
  CfVoiceRealtimeOpenAIAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const getWeather = tool({
  description:
    "Look up the current weather for a city. Use this when the user asks about the weather.",
  inputSchema: z.object({ city: z.string().describe("City name, e.g. 'Tokyo'") }),
  async execute({ city }) {
    // Stub impl — deterministic payload so the smoke test is repeatable.
    return { city, temperatureC: 21, condition: "partly cloudy" };
  },
});

export class CfVoiceRealtimeOpenAIAgent extends KuralleRealtimeVoiceAgent<Env> {
  createRealtimeModel(env: Env) {
    const provider = env.PROVIDER ?? "openai";
    if (provider === "xai") {
      if (!env.XAI_API_KEY) {
        throw new Error(
          "PROVIDER=xai but XAI_API_KEY secret is missing. Run: wrangler secret put XAI_API_KEY",
        );
      }
      return new CloudflareXAIGrokRealtimeClient({
        apiKey: env.XAI_API_KEY,
        // Defaults: grok-4-1-fast-non-reasoning + ara + server_vad.
      });
    }
    if (!env.OPENAI_API_KEY) {
      throw new Error(
        "PROVIDER=openai but OPENAI_API_KEY secret is missing. Run: wrangler secret put OPENAI_API_KEY",
      );
    }
    return new CloudflareOpenAIRealtimeClient({
      apiKey: env.OPENAI_API_KEY,
      // Pin to gpt-realtime-1.5 — see
      // https://developers.openai.com/api/docs/models/gpt-realtime-1.5
      model: 'gpt-realtime-1.5',
    });
  }

  protected getAgents() {
    return [
      {
        id: "assistant",
        name: "Assistant",
        instructions: [
          "You are a helpful voice assistant. You are speaking out loud — every word you produce will be heard, not read.",
          "",
          "## Language",
          "- Detect the language the user is speaking and reply in that same language. If the user speaks English, you must reply in English.",
          "- If the user explicitly asks you to switch languages, switch immediately and stay in that language until they ask otherwise.",
          "- Speak each language as a native speaker of that language would. Do not carry an English accent into other languages, and do not carry another language's accent into English.",
          "- For proper nouns and brand names, use the local pronunciation of the language you are currently speaking.",
          "- Never mix languages in a single reply unless the user mixed them first.",
          "",
          "## Voice and delivery",
          "- Keep replies short — one or two sentences.",
          "- Sound conversational and warm, not formal or scripted.",
          "- Vary pacing and intonation; no flat cadence.",
          "- Spell numbers, dates, times, and units the way a person would say them aloud (\"twenty twenty-six\", not \"2026\"; \"three thirty p.m.\", not \"15:30\").",
          "- No markdown, no bullet points, no asterisks, no emoji — the user cannot see them.",
          "",
          "## Tools",
          "- If the user asks about the weather, call getWeather and narrate the result naturally in the current language. Do not read raw JSON.",
        ].join("\n"),
        tools: { getWeather },
      },
    ];
  }

  protected getDefaultAgentId() {
    return "assistant";
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env, { cors: true });
    if (routed) return routed;
    return env.ASSETS.fetch(request);
  },
};
