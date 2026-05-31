"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import {
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useWindowSize } from "usehooks-ts";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "../ai-elements/prompt-input";
import { StopIcon } from "./icons";
import { SuggestedActions } from "./suggested-actions";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

function PureMultimodalInput({
  chatId,
  input,
  setInput,
  status,
  stop,
  messages,
  sendMessage,
  className,
  editingMessage,
  onCancelEdit,
}: {
  chatId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage:
    | UseChatHelpers<ChatMessage>["sendMessage"]
    | (() => Promise<void>);
  className?: string;
  selectedModelId: string;
  onModelChange?: (modelId: string) => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const hasAutoFocused = useRef(false);

  useEffect(() => {
    if (!hasAutoFocused.current && width) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        hasAutoFocused.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [width]);

  const submitForm = useCallback(() => {
    if (!input.trim()) {
      return;
    }

    window.history.pushState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`,
    );

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: input }],
    });

    setInput("");

    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [input, setInput, sendMessage, width, chatId]);

  return (
    <div className={cn("relative flex w-full flex-col gap-3", className)}>
      {messages.length === 0 && (
        <SuggestedActions chatId={chatId} sendMessage={sendMessage} />
      )}

      {editingMessage && (
        <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
          <span>Editing message</span>
          <button
            className="text-foreground hover:underline"
            onClick={onCancelEdit}
            type="button"
          >
            Cancel
          </button>
        </div>
      )}

      <PromptInput
        className="rounded-2xl border border-border/50 bg-background shadow-[var(--shadow-card)]"
        onSubmit={(_message, event) => {
          event.preventDefault();
          if (status === "streaming" || status === "submitted") {
            return;
          }
          submitForm();
        }}
      >
        <PromptInputTextarea
          autoFocus
          className="min-h-[52px] resize-none border-0 bg-transparent px-4 py-3 text-[13px] shadow-none focus-visible:ring-0"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Send a message..."
          ref={textareaRef}
          rows={1}
          value={input}
        />
        <PromptInputFooter className="px-2 pb-2">
          <div className="ml-auto flex items-center gap-1">
            {status === "streaming" || status === "submitted" ? (
              <button
                className="inline-flex size-8 items-center justify-center rounded-lg border border-border/50 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={stop}
                type="button"
              >
                <StopIcon size={14} />
              </button>
            ) : (
              <PromptInputSubmit disabled={!input.trim()} status={status} />
            )}
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

export const MultimodalInput = memo(PureMultimodalInput);
