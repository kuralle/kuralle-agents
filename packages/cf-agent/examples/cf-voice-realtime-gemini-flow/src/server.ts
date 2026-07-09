/**
 * Kuralle realtime voice agent on Cloudflare — flow variant.
 *
 * Same realtime stack as `cf-voice-realtime-gemini` (Gemini Live audio via
 * `CloudflareGeminiLiveClient`), but `getAgents()` returns a flow agent rather
 * than a single LLM agent. Demonstrates that the Kuralle authority drives
 * node transitions and tool routing over a realtime audio session.
 *
 * Flow shape ports the e-commerce scenario from the Fly direct-plugin server
 * (apps/playground/fly-voice-agent/server-agentsession-kuralle-direct.mjs):
 *   hub  ──route_to_tracking──▶  tracking
 *   tracking  ──back_to_hub──▶  hub
 */

import { KuralleRealtimeVoiceAgent } from "@kuralle-agents/cf-agent/voice";
import { CloudflareGeminiLiveClient } from "@kuralle-agents/realtime-audio";
import {
  createFlowTransition,
  defineFlow,
  defineAgent,
  reply,
  buildToolSet,
  defineTool,
} from "@kuralle-agents/core";
import { routeAgentRequest } from "agents";
import { z } from "zod";

export interface Env {
  GEMINI_API_KEY: string;
  CfVoiceRealtimeFlowAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI: unknown;
}

const MODEL = "gemini-3.1-flash-live-preview";
const VOICE = "Charon";

const SYSTEM_INSTRUCTIONS = [
  "You are a helpful customer service voice agent for ShopNow, an online store. You are speaking out loud — every word you produce will be heard, not read.",
  "",
  "## Language",
  "- Detect the language the user is speaking and reply in that same language.",
  "- If the user explicitly asks you to switch languages, switch immediately and stay in that language until they ask otherwise.",
  "- Speak each language as a native speaker of that language would. Do not carry an English accent into other languages, and do not carry another language's accent into English.",
  "- For proper nouns and brand names (including \"ShopNow\"), use the local pronunciation of the language you are currently speaking.",
  "- Never mix languages in a single reply unless the user mixed them first.",
  "",
  "## Voice and delivery",
  "- Keep replies short — one or two sentences.",
  "- Sound conversational and warm, not formal or scripted.",
  "- Vary pacing and intonation; no flat cadence.",
  "- Spell numbers, dates, times, and order numbers the way a person would say them aloud (\"order ten oh forty-two\", not \"ORD-10042\").",
  "- No markdown, no bullet points, no asterisks, no emoji — the user cannot see them.",
  "",
  "## Behavior",
  "- Be friendly and efficient.",
  "- Use the available tools to route the conversation and look up orders. Do not narrate that you are using a tool.",
].join("\n");

const trackingNode = reply({
  id: "tracking",
  instructions: [
    "You are helping the customer track their order.",
    "Ask for the order number if it has not been provided.",
    "Once you have it, call lookup_order.",
    "When the customer is done tracking, call back_to_hub.",
  ].join("\n"),
  tools: buildToolSet({
    lookup_order: defineTool({
      name: "lookup_order",
      description: "Look up order status by order number",
      input: z.object({
        orderNumber: z.string().describe("Order number like ORD-10042"),
      }),
      execute: async ({ orderNumber }) => ({
        orderNumber,
        status: "shipped",
        carrier: "FedEx",
        eta: "Tomorrow by 5pm",
      }),
    }),
    back_to_hub: defineTool({
      name: "back_to_hub",
      description: "Return to the main menu when tracking is done",
      input: z.object({}),
      execute: async () => createFlowTransition("hub"),
    }),
  }),
});

const hubNode = reply({
  id: "hub",
  instructions: [
    "You are at the main customer service hub.",
    "Handle general questions directly (store hours: 9am to 6pm Monday through Saturday).",
    "If the customer wants to track an order, call route_to_tracking.",
  ].join("\n"),
  tools: buildToolSet({
    route_to_tracking: defineTool({
      name: "route_to_tracking",
      description: "Route to order tracking when the customer wants to track an order",
      input: z.object({}),
      execute: async () => createFlowTransition("tracking"),
    }),
  }),
});

const ecomFlow = defineFlow({
  name: "ecom-support",
  description: "Customer service with order tracking",
  start: hubNode,
  nodes: [hubNode, trackingNode],
});

export class CfVoiceRealtimeFlowAgent extends KuralleRealtimeVoiceAgent<Env> {
  createRealtimeModel(env: Env) {
    return new CloudflareGeminiLiveClient({
      apiKey: env.GEMINI_API_KEY,
      model: MODEL,
      voice: VOICE,
    });
  }

  protected getAgents() {
    return [
      defineAgent({
        id: "ecom-support",
        name: "E-Commerce Support",
        description: "Customer service with order tracking",
        instructions: SYSTEM_INSTRUCTIONS,
        flows: [ecomFlow],
      }),
    ];
  }

  protected getDefaultAgentId() {
    return "ecom-support";
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const routed = await routeAgentRequest(request, env, { cors: true });
    if (routed) return routed;
    return env.ASSETS.fetch(request);
  },
};
