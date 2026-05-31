import { openai } from "@ai-sdk/openai";
import {
  createRuntime,
  defineAgent,
  MemoryStore,
  type SessionStore,
} from "@kuralle-agents/core";
import { PostgresSessionStore } from "@kuralle-agents/postgres-store";
import { Pool } from "pg";

const modelId = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

function createSessionStore(): SessionStore {
  const postgresUrl = process.env.POSTGRES_URL;
  if (postgresUrl) {
    const pool = new Pool({ connectionString: postgresUrl });
    return new PostgresSessionStore({ client: pool });
  }
  return new MemoryStore();
}

export const chatAgent = defineAgent({
  id: "chat-assistant",
  name: "Chat Assistant",
  description: "Kuralle-powered chat assistant",
  instructions: `You are a helpful assistant powered by Kuralle.
Be concise, accurate, and friendly. Answer questions clearly and ask follow-up questions when useful.`,
  model: openai(modelId),
});

export const runtime = createRuntime({
  agents: [chatAgent],
  defaultAgentId: chatAgent.id,
  defaultModel: openai(modelId),
  sessionStore: createSessionStore(),
});
