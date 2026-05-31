/**
 * Cloudflare realtime voice demo.
 *
 * Pairs `KuralleRealtimeVoiceAgent` with `CloudflareGeminiLiveClient`.
 * The Durable Object handles audio passthrough, tool dispatch,
 * transcript persistence, and session resumption; the Worker's `fetch` handler
 * routes browser connections via the `agents` SDK's `routeAgentRequest` helper,
 * falling back to the Vite-built static client assets.
 */

import { KuralleRealtimeVoiceAgent } from "@kuralle-agents/cf-agent/voice";
import { CloudflareGeminiLiveClient } from "@kuralle-agents/realtime-audio";
import { routeAgentRequest } from "agents";
import { tool } from "ai";
import { z } from "zod";

export interface Env {
  GEMINI_API_KEY: string;
  CfVoiceRealtimeAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI: unknown;
}

const getWeather = tool({
  description:
    "Look up the current weather for a city. Use this when the user asks about the weather.",
  inputSchema: z.object({ city: z.string().describe("City name, e.g. 'Tokyo'") }),
  async execute({ city }) {
    // Stub impl — returns deterministic data so the smoke test is repeatable.
    return { city, temperatureC: 21, condition: "partly cloudy" };
  },
});

// Voice + model are locked per Wave 3 brief:
//   model = gemini-3.1-flash-live-preview (half-cascade)
//   voice = Charon (fallback Puck if provider rejects — documented in FINDINGS)
const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Charon";

export class CfVoiceRealtimeAgent extends KuralleRealtimeVoiceAgent<Env> {
  createRealtimeModel(env: Env) {
    return new CloudflareGeminiLiveClient({
      apiKey: env.GEMINI_API_KEY,
      model: MODEL,
      voice: VOICE,
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
          "- Detect the language the user is speaking and reply in that same language.",
          "- If the user explicitly asks you to switch languages (e.g. \"talk to me in Spanish\", \"répondez en français\", \"日本語で話して\"), switch immediately and stay in that language until they ask otherwise.",
          "- Speak each language as a native speaker of that language would. Do not carry an English accent into other languages, and do not carry another language's accent into English. Pronunciation, rhythm, and intonation must match the target language natively.",
          "- For proper nouns, brand names, and place names, use the local pronunciation of whatever language you are currently speaking — not the English version.",
          "- Never mix languages in a single reply unless the user mixed them first.",
          "",
          "## Voice and delivery",
          "- Keep replies short — one or two sentences. Voice replies that run long feel like a lecture.",
          "- Sound conversational and warm, not formal or scripted. Use contractions where the language allows.",
          "- Vary your pacing and intonation; do not deliver everything in the same flat cadence.",
          "- Spell numbers, dates, times, currencies, and units out the way a person would say them aloud (\"twenty twenty-six\", not \"2026\"; \"three thirty p.m.\", not \"15:30\").",
          "- No markdown, no bullet points, no asterisks, no emoji, no \"here is a list\" — the user cannot see any of that. Speak in plain prose.",
          "- If you need to pause for emphasis, use a comma or a period. Do not narrate stage directions like \"*sighs*\" or \"(pauses)\".",
          "",
          "## Tools",
          "- If the user asks about the weather, call the getWeather tool and narrate the result naturally in the current language. Do not read the raw JSON; describe it the way a person would.",
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
    // Agents SDK routing: /agents/<class>/<instance> (HTTP + WebSocket upgrade).
    const routed = await routeAgentRequest(request, env, { cors: true });
    if (routed) return routed;

    // Everything else → Vite-built client assets (index.html, JS, CSS).
    return env.ASSETS.fetch(request);
  },
};
