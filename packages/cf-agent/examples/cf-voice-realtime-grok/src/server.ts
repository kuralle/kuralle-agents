/**
 * Kuralle realtime voice agent on Cloudflare — xAI Grok single-agent variant.
 *
 * Pairs `KuralleRealtimeVoiceAgent` with `CloudflareXAIGrokRealtimeClient`.
 * xAI's Voice API is OpenAI-protocol-compatible, so this is the
 * same authority/audio path as the OpenAI worker — just with the endpoint
 * locked to `wss://api.x.ai/v1/realtime` and Grok defaults
 * (model `grok-4-1-fast-non-reasoning`, voice `ara`, `server_vad`).
 *
 * No LiveKit involved. Required secret: XAI_API_KEY.
 */

import { KuralleRealtimeVoiceAgent } from "@kuralle-agents/cf-agent/voice";
import { CloudflareXAIGrokRealtimeClient } from "@kuralle-agents/realtime-audio";
import { routeAgentRequest } from "agents";
import { tool } from "ai";
import { z } from "zod";
import { wrapAiSdkTool } from "@kuralle-agents/core";

export interface Env {
  XAI_API_KEY: string;
  CfVoiceRealtimeGrokAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const SYSTEM_PROMPT = [
  "You are a helpful voice assistant. You are speaking out loud — every word you produce will be heard, not read.",
  "",
  "## Language",
  "- Detect the language the user is speaking and reply in that same language.",
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
].join("\n");

const getWeather = tool({
  description:
    "Look up the current weather for a city. Use this when the user asks about the weather.",
  inputSchema: z.object({ city: z.string().describe("City name, e.g. 'Tokyo'") }),
  async execute({ city }) {
    return { city, temperatureC: 21, condition: "partly cloudy" };
  },
});

export class CfVoiceRealtimeGrokAgent extends KuralleRealtimeVoiceAgent<Env> {
  createRealtimeModel(env: Env) {
    if (!env.XAI_API_KEY) {
      throw new Error("XAI_API_KEY secret is missing. Run: wrangler secret put XAI_API_KEY");
    }
    return new CloudflareXAIGrokRealtimeClient({
      apiKey: env.XAI_API_KEY,
    });
  }

  protected getAgents() {
    return [
      {
        id: "assistant",
        name: "Assistant",
        instructions: SYSTEM_PROMPT,
        tools: { getWeather: wrapAiSdkTool("getWeather", getWeather) },
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
