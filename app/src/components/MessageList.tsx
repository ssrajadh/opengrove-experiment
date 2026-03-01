"use client";

import { useState, useEffect, useMemo } from "react";
import type { ClientMessage } from "@/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

function QuoteBlock({ quotedMessage }: { quotedMessage: ClientMessage }) {
  const truncated =
    quotedMessage.content.length > 120
      ? quotedMessage.content.slice(0, 120) + "..."
      : quotedMessage.content;

  return (
    <div className="mb-2 border-l-2 border-zinc-600 pl-3 py-1">
      <p className="text-xs text-zinc-500 mb-0.5">
        {quotedMessage.role === "user" ? "You" : "Assistant"}
      </p>
      <p className="text-xs text-zinc-400 line-clamp-2 whitespace-pre-wrap">
        {truncated}
      </p>
    </div>
  );
}

export default function MessageList({
  messages,
  onBranch,
  onReply,
  highlightMessageId,
}: {
  messages: ClientMessage[];
  onBranch?: (messageIndex: number) => void;
  onReply?: (msg: ClientMessage) => void;
  highlightMessageId?: string | null;
}) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  useEffect(() => {
    if (highlightMessageId) {
      setHighlightedId(highlightMessageId);
      const timer = setTimeout(() => setHighlightedId(null), 2500);
      return () => clearTimeout(timer);
    } else {
      setHighlightedId(null);
    }
  }, [highlightMessageId]);

  const messageMap = useMemo(() => {
    const map = new Map<string, ClientMessage>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const handleCopy = async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageId(messageId);
      window.setTimeout(() => {
        setCopiedMessageId((prev) => (prev === messageId ? null : prev));
      }, 1200);
    } catch {
      // Ignore clipboard errors in unsupported contexts.
    }
  };

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
        Send a message to start
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex-1 overflow-y-auto p-4 pb-28 space-y-7">
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          const quotedMessage = m.replyToId ? messageMap.get(m.replyToId) : undefined;

          const actionButtons = m.content && (
            <div className="mt-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {onReply && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-zinc-500 hover:text-zinc-300"
                      onClick={() => onReply(m)}
                    >
                      ↩ Reply
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Reply to this message
                  </TooltipContent>
                </Tooltip>
              )}
              {onBranch && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-zinc-500 hover:text-zinc-300"
                      onClick={() => onBranch(idx)}
                    >
                      ⑂ Branch
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Branch conversation from this message
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-zinc-500 hover:text-zinc-300"
                    onClick={() => handleCopy(m.id, m.content)}
                  >
                    {copiedMessageId === m.id ? "⎘ Copied" : "⎘ Copy"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Copy message text
                </TooltipContent>
              </Tooltip>
            </div>
          );

          return (
            <div
              key={m.id}
              id={`msg-${m.id}`}
              className={cn(
                "group mx-auto flex w-full max-w-3xl items-end gap-2",
                isUser ? "justify-end" : "justify-start",
                highlightedId === m.id && "search-highlight"
              )}
            >
              {/* Assistant message: left-aligned, no bubble */}
              {!isUser && (
                <div className="flex-1 min-w-0 flex flex-col">
                  {quotedMessage && <QuoteBlock quotedMessage={quotedMessage} />}
                  <div className="prose-chat break-words">
                    <ReactMarkdown
                      remarkPlugins={remarkPlugins}
                      rehypePlugins={rehypePlugins}
                    >
                      {m.content}
                    </ReactMarkdown>
                  </div>
                  {actionButtons}
                </div>
              )}

              {/* User message: right-aligned muted bubble */}
              {isUser && (
                <div className="max-w-[85%] flex flex-col items-end">
                  {quotedMessage && <QuoteBlock quotedMessage={quotedMessage} />}
                  <div className="rounded-2xl rounded-br-sm bg-zinc-800 border border-zinc-700/50 px-4 py-3">
                    <p className="whitespace-pre-wrap break-words text-base leading-7 text-zinc-100">
                      {m.content}
                    </p>
                  </div>
                  {actionButtons}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
