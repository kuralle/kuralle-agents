export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export const chatModels: ChatModel[] = [
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    description: "Fast, capable OpenAI model via Kuralle",
  },
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    description: "OpenAI flagship model via Kuralle",
  },
];

export const allowedModelIds = new Set(chatModels.map((model) => model.id));

export function getActiveModels(): ChatModel[] {
  const configured = process.env.OPENAI_MODEL;
  if (configured && allowedModelIds.has(configured)) {
    return chatModels.filter((model) => model.id === configured);
  }
  return chatModels;
}
