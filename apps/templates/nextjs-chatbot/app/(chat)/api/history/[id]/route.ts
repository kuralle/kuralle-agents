import { runtime } from "@/lib/kuralle/agent";
import { ChatbotError } from "@/lib/errors";
import { getUserId } from "@/lib/user";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;
  const userId = await getUserId();
  const store = runtime.getSessionStore();
  const session = await store.get(sessionId);

  if (!session) {
    return new ChatbotError("not_found:history").toResponse();
  }

  if (session.userId && session.userId !== userId) {
    return new ChatbotError("forbidden:history").toResponse();
  }

  await store.delete(sessionId);
  return Response.json({ id: sessionId });
}
