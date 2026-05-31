import { runtime } from "@/lib/kuralle/agent";
import { modelMessagesToChatMessages } from "@/lib/kuralle/messages";
import {
  getThreadModelMessages,
  syncSessionMessages,
} from "@/lib/kuralle/session-helpers";
import { ChatbotError } from "@/lib/errors";
import { getUserId } from "@/lib/user";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  const userId = await getUserId();
  const store = runtime.getSessionStore();
  const session = await store.get(sessionId);

  if (!session) {
    return new ChatbotError("not_found:chat").toResponse();
  }

  if (session.userId && session.userId !== userId) {
    return new ChatbotError("forbidden:chat").toResponse();
  }

  const modelMessages = getThreadModelMessages(session);
  if (modelMessages.length > session.messages.length) {
    syncSessionMessages(session);
    await store.save(session);
  }

  const messages = modelMessagesToChatMessages(modelMessages);
  return Response.json({ id: sessionId, messages });
}
