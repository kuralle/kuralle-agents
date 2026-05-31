import type { ModelMessage } from "ai";
import type { Session } from "@kuralle-agents/core";

type PersistedRun = {
  runState: {
    messages: ModelMessage[];
  };
};

type SessionWithRuns = Session & {
  durableRuns?: Record<string, PersistedRun>;
};

export type ChatThreadMetadata = {
  title?: string;
};

export function getThreadModelMessages(session: Session): ModelMessage[] {
  const runs = (session as SessionWithRuns).durableRuns;
  const persisted = runs?.[session.id];
  if (persisted?.runState.messages.length) {
    return persisted.runState.messages;
  }
  return session.messages;
}

export function syncSessionMessages(session: Session): void {
  session.messages = [...getThreadModelMessages(session)];
}

function readThreadTitle(session: Session): string | undefined {
  const metadata = session.metadata as
    | (NonNullable<Session["metadata"]> & ChatThreadMetadata)
    | undefined;
  return metadata?.title;
}

export function getThreadTitle(session: Session): string {
  const title = readThreadTitle(session);
  if (title) {
    return title;
  }

  for (const message of getThreadModelMessages(session)) {
    if (message.role === "user") {
      const text = extractTextFromModelMessage(message);
      if (text) {
        return truncateTitle(text);
      }
    }
  }

  return "New chat";
}

export function setThreadTitleIfMissing(
  session: Session,
  firstUserText: string,
): void {
  if (readThreadTitle(session)) {
    return;
  }

  const now = new Date();
  const existing = session.metadata;
  const metadata: NonNullable<Session["metadata"]> & ChatThreadMetadata = {
    createdAt: existing?.createdAt ?? now,
    lastActiveAt: now,
    totalTokens: existing?.totalTokens ?? 0,
    totalSteps: existing?.totalSteps ?? 0,
    handoffHistory: existing?.handoffHistory ?? [],
    title: truncateTitle(firstUserText),
  };
  session.metadata = metadata as NonNullable<Session["metadata"]>;
}

export function extractTextFromModelMessage(message: ModelMessage): string {
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

function truncateTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 60) {
    return trimmed;
  }
  return `${trimmed.slice(0, 57)}...`;
}
