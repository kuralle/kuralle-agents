"use client";

import { PanelLeftIcon } from "lucide-react";
import Link from "next/link";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";

function PureChatHeader({
  chatId: _chatId,
  isReadonly: _isReadonly,
}: {
  chatId: string;
  isReadonly: boolean;
}) {
  const { state, toggleSidebar, isMobile } = useSidebar();

  if (state === "collapsed" && !isMobile) {
    return null;
  }

  return (
    <header className="sticky top-0 flex h-14 items-center gap-2 bg-sidebar px-3">
      <Button
        className="md:hidden"
        onClick={toggleSidebar}
        size="icon-sm"
        variant="ghost"
      >
        <PanelLeftIcon className="size-4" />
      </Button>

      <div className="font-medium text-[13px] text-sidebar-foreground/80 md:ml-1">
        Kuralle Chat
      </div>

      <Button
        asChild
        className="hidden rounded-lg bg-foreground px-4 text-background hover:bg-foreground/90 md:ml-auto md:flex"
      >
        <Link
          href="https://github.com/openscoped/aria-flow"
          rel="noopener noreferrer"
          target="_blank"
        >
          View Kuralle
        </Link>
      </Button>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
