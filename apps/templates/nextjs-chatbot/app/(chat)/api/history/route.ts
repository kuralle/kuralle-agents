import { runtime } from "@/lib/kuralle/agent";
import {
  getThreadModelMessages,
  getThreadTitle,
} from "@/lib/kuralle/session-helpers";
import type { ChatHistory, HistoryChat } from "@/lib/history";
import { getUserId } from "@/lib/user";

export async function GET(request: Request) {
  const userId = await getUserId();
  const { searchParams } = new URL(request.url);
  const limit = Number.parseInt(searchParams.get("limit") ?? "20", 10);
  const endingBefore = searchParams.get("ending_before");

  const sessions = await runtime.getSessionStore().list(userId);
  const sorted = sessions
    .filter((session) => getThreadModelMessages(session).length > 0)
    .sort(
      (left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime(),
    );

  let filtered = sorted;
  if (endingBefore) {
    const index = sorted.findIndex((session) => session.id === endingBefore);
    if (index >= 0) {
      filtered = sorted.slice(index + 1);
    }
  }

  const page = filtered.slice(0, limit);
  const chats: HistoryChat[] = page.map((session) => ({
    id: session.id,
    title: getThreadTitle(session),
    createdAt: session.createdAt.toISOString(),
  }));

  const response: ChatHistory = {
    chats,
    hasMore: filtered.length > limit,
  };

  return Response.json(response);
}
