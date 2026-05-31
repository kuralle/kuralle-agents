import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { runtime } from "@/lib/kuralle/agent";
import { persistThreadAfterTurn } from "@/lib/kuralle/persist-thread";
import { bridgeHarnessStreamToUI } from "@/lib/kuralle/stream-bridge";
import { ChatbotError } from "@/lib/errors";
import { getUserId } from "@/lib/user";
import { getTextFromMessage } from "@/lib/utils";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch {
    return new ChatbotError("bad_request:api").toResponse();
  }

  if (!process.env.OPENAI_API_KEY) {
    return new ChatbotError("offline:chat").toResponse();
  }

  try {
    const { id: sessionId, message, messages } = requestBody;

    const latestMessage = message ?? messages?.at(-1);
    if (!latestMessage || latestMessage.role !== "user") {
      return new ChatbotError("bad_request:api").toResponse();
    }

    const input = getTextFromMessage({
      id: latestMessage.id,
      role: "user",
      parts: latestMessage.parts as Array<{ type: string; text?: string }>,
    });

    if (!input.trim()) {
      return new ChatbotError("bad_request:api").toResponse();
    }

    const userId = await getUserId();

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const handle = runtime.run({
          sessionId,
          input,
          agentId: "chat-assistant",
          userId,
        });
        await bridgeHarnessStreamToUI(writer, handle);
        await persistThreadAfterTurn(sessionId, input);
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    if (error instanceof ChatbotError) {
      return error.toResponse();
    }

    return new ChatbotError("offline:chat").toResponse();
  }
}
