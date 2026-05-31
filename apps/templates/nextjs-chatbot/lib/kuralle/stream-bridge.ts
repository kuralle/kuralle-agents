import type { HarnessStreamPart, TurnHandle } from "@kuralle-agents/core";
import { generateId, type UIMessageStreamWriter } from "ai";
import type { ChatMessage } from "@/lib/types";

export async function bridgeHarnessStreamToUI(
  writer: UIMessageStreamWriter<ChatMessage>,
  handle: TurnHandle,
): Promise<void> {
  let textPartId: string | undefined;
  let textStarted = false;

  for await (const part of handle.events) {
    applyHarnessPart(writer, part, {
      getTextPartId: () => {
        if (!textPartId) {
          textPartId = generateId();
        }
        return textPartId;
      },
      isTextStarted: () => textStarted,
      setTextStarted: (value: boolean) => {
        textStarted = value;
        if (!value) {
          textPartId = undefined;
        }
      },
    });
  }

  if (textStarted && textPartId) {
    writer.write({ type: "text-end", id: textPartId });
  }

  await handle.catch(() => {});
}

function applyHarnessPart(
  writer: UIMessageStreamWriter<ChatMessage>,
  part: HarnessStreamPart,
  text: {
    getTextPartId: () => string;
    isTextStarted: () => boolean;
    setTextStarted: (value: boolean) => void;
  },
): void {
  switch (part.type) {
    case "text-delta": {
      if (!part.text) {
        return;
      }
      if (!text.isTextStarted()) {
        const id = text.getTextPartId();
        writer.write({ type: "text-start", id });
        text.setTextStarted(true);
      }
      writer.write({
        type: "text-delta",
        id: text.getTextPartId(),
        delta: part.text,
      });
      return;
    }
    case "tool-call": {
      if (text.isTextStarted()) {
        writer.write({ type: "text-end", id: text.getTextPartId() });
        text.setTextStarted(false);
      }
      writer.write({
        type: "tool-input-available",
        toolCallId: part.toolCallId ?? generateId(),
        toolName: part.toolName,
        input: part.args,
      });
      return;
    }
    case "tool-result": {
      writer.write({
        type: "tool-output-available",
        toolCallId: part.toolCallId ?? "unknown",
        output: part.result,
      });
      return;
    }
    case "error": {
      throw new Error(part.error);
    }
    default:
      return;
  }
}
