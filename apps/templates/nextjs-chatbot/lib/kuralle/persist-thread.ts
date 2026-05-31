import { runtime } from "@/lib/kuralle/agent";
import {
  setThreadTitleIfMissing,
  syncSessionMessages,
} from "@/lib/kuralle/session-helpers";
import { getUserId } from "@/lib/user";

export async function persistThreadAfterTurn(
  sessionId: string,
  latestUserInput: string,
): Promise<void> {
  const store = runtime.getSessionStore();
  const session = await store.get(sessionId);
  if (!session) {
    return;
  }

  const userId = await getUserId();
  if (!session.userId) {
    session.userId = userId;
  }

  syncSessionMessages(session);
  setThreadTitleIfMissing(session, latestUserInput);
  await store.save(session);
}
