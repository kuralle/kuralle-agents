import type { ModelMessage } from "ai";
import { generateId } from "ai";
import type { ChatMessage } from "@/lib/types";

export function modelMessagesToChatMessages(
  messages: ModelMessage[],
): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractMessageText(message);
    if (!text) {
      continue;
    }

    chatMessages.push({
      id: generateId(),
      role: message.role,
      parts: [{ type: "text", text }],
      metadata: { createdAt: new Date().toISOString() },
    });
  }

  return chatMessages;
}

function extractMessageText(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("")
    .trim();
}
