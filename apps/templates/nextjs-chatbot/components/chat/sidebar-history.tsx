"use client";

import { motion } from "framer-motion";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWRInfinite from "swr/infinite";
import type { ChatHistory } from "@/lib/history";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar";
import { fetcher } from "@/lib/utils";
import { LoaderIcon } from "./icons";
import { ChatItem } from "./sidebar-history-item";

const PAGE_SIZE = 20;

export function getChatHistoryPaginationKey(
  pageIndex: number,
  previousPageData: ChatHistory | null,
) {
  if (previousPageData && previousPageData.hasMore === false) {
    return null;
  }

  if (pageIndex === 0) {
    return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history?limit=${PAGE_SIZE}`;
  }

  const firstChatFromPage = previousPageData?.chats.at(-1);
  if (!firstChatFromPage) {
    return null;
  }

  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history?ending_before=${firstChatFromPage.id}&limit=${PAGE_SIZE}`;
}

export function SidebarHistory() {
  const { setOpenMobile } = useSidebar();
  const pathname = usePathname();
  const activeChatId = pathname?.startsWith("/chat/")
    ? pathname.split("/")[2]
    : null;

  const {
    data: paginatedChatHistories,
    setSize,
    isValidating,
    isLoading,
    mutate,
  } = useSWRInfinite<ChatHistory>(getChatHistoryPaginationKey, fetcher, {
    fallbackData: [],
    revalidateOnFocus: true,
  });

  const router = useRouter();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const hasReachedEnd = paginatedChatHistories
    ? paginatedChatHistories.some((page) => page.hasMore === false)
    : false;

  const hasEmptyChatHistory = paginatedChatHistories
    ? paginatedChatHistories.every((page) => page.chats.length === 0)
    : false;

  const handleDelete = async () => {
    const chatToDelete = deleteId;
    if (!chatToDelete) {
      return;
    }

    const isCurrentChat = pathname === `/chat/${chatToDelete}`;

    setShowDeleteDialog(false);

    if (isCurrentChat) {
      router.replace(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/`);
    }

    mutate(
      (chatHistories) => {
        if (!chatHistories) {
          return chatHistories;
        }
        return chatHistories.map((chatHistory) => ({
          ...chatHistory,
          chats: chatHistory.chats.filter((chat) => chat.id !== chatToDelete),
        }));
      },
      { revalidate: false },
    );

    try {
      await fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history/${chatToDelete}`,
        { method: "DELETE" },
      );
      toast.success("Chat deleted");
    } catch {
      toast.error("Failed to delete chat");
      mutate();
    }
  };

  if (isLoading) {
    return (
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>History</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex flex-col gap-2 px-2 py-1">
            {[44, 32, 28, 64, 52].map((item) => (
              <div
                className="h-4 animate-pulse rounded-md bg-sidebar-accent-foreground/10"
                key={item}
                style={{ width: `${item}%` }}
              />
            ))}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  if (hasEmptyChatHistory) {
    return (
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>History</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="px-3 py-6 text-[13px] text-sidebar-foreground/40">
            Your conversations will appear here once you start chatting.
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    );
  }

  const chatsFromHistory =
    paginatedChatHistories?.flatMap((page) => page.chats) ?? [];

  return (
    <>
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>History</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {chatsFromHistory.map((chat) => (
              <ChatItem
                chat={chat}
                isActive={chat.id === activeChatId}
                key={chat.id}
                onDelete={(chatId) => {
                  setDeleteId(chatId);
                  setShowDeleteDialog(true);
                }}
                setOpenMobile={setOpenMobile}
              />
            ))}
          </SidebarMenu>

          <motion.div
            onViewportEnter={() => {
              if (!isValidating && !hasReachedEnd) {
                setSize((size) => size + 1);
              }
            }}
          />

          {hasReachedEnd ? null : (
            <div className="mt-4 flex flex-row items-center gap-2 p-2 text-sidebar-foreground/50">
              <div className="animate-spin">
                <LoaderIcon />
              </div>
              <div className="text-[13px]">Loading...</div>
            </div>
          )}
        </SidebarGroupContent>
      </SidebarGroup>

      <AlertDialog onOpenChange={setShowDeleteDialog} open={showDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete this
              chat thread.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
