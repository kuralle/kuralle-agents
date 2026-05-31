"use client";

import { useEffect, useRef, useState } from "react";
import { useActiveChat } from "@/hooks/use-active-chat";
import type { ChatMessage } from "@/lib/types";
import { ChatHeader } from "./chat-header";
import { Messages } from "./messages";
import { MultimodalInput } from "./multimodal-input";

export function ChatShell() {
  const {
    chatId,
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    addToolApprovalResponse,
    input,
    setInput,
    isReadonly,
    currentModelId,
    setCurrentModelId,
  } = useActiveChat();

  const [editingMessage, setEditingMessage] = useState<ChatMessage | null>(
    null,
  );

  const stopRef = useRef(stop);
  stopRef.current = stop;

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      stopRef.current();
      setEditingMessage(null);
    }
  }, [chatId]);

  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div className="flex min-w-0 flex-col bg-sidebar transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] w-full">
        <ChatHeader chatId={chatId} isReadonly={isReadonly} />

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-tl-[12px] md:border-t md:border-l md:border-border/40">
          <Messages
            addToolApprovalResponse={addToolApprovalResponse}
            chatId={chatId}
            isReadonly={isReadonly}
            messages={messages}
            onEditMessage={(msg) => {
              const text = msg.parts
                ?.filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("");
              setInput(text ?? "");
              setEditingMessage(msg);
            }}
            regenerate={regenerate}
            selectedModelId={currentModelId}
            setMessages={setMessages}
            status={status}
          />

          <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 pb-3 md:px-4 md:pb-4">
            {!isReadonly && (
              <MultimodalInput
                chatId={chatId}
                editingMessage={editingMessage}
                input={input}
                messages={messages}
                onCancelEdit={() => {
                  setEditingMessage(null);
                  setInput("");
                }}
                onModelChange={setCurrentModelId}
                selectedModelId={currentModelId}
                sendMessage={sendMessage}
                setInput={setInput}
                setMessages={setMessages}
                status={status}
                stop={stop}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
