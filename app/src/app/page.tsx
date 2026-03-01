"use client";

import { useState, useEffect, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import MessageList from "@/components/MessageList";
import ChatInput from "@/components/ChatInput";
import type { Conversation, ClientMessage } from "@/types";

type Message = ClientMessage;

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("gemini-2.0-flash");
  const [loading, setLoading] = useState(false);
  const [conversationCost, setConversationCost] = useState(0);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);

  const fetchConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    if (res.ok) {
      const data = await res.json();
      setConversations(data);
    }
  }, []);

  const fetchMessages = useCallback(async (id: string) => {
    const res = await fetch(`/api/conversations/${id}`);
    if (res.ok) {
      const data = await res.json();
      const msgs = (data.messages ?? []).map(
        (m: { id: string; role: "user" | "assistant"; content: string; reply_to_id?: string | null }) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          replyToId: m.reply_to_id ?? null,
        })
      );
      setMessages(msgs);
    } else {
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const fetchCost = useCallback(async (id: string) => {
    const res = await fetch(`/api/conversations/${id}/cost`);
    if (res.ok) {
      const data = await res.json();
      setConversationCost(data.totalCost ?? 0);
    }
  }, []);

  useEffect(() => {
    if (currentId) {
      fetchMessages(currentId);
      fetchCost(currentId);
    } else {
      setMessages([]);
      setConversationCost(0);
    }
  }, [currentId, fetchMessages, fetchCost]);

  const handleSearchSelect = useCallback(
    (conversationId: string, messageId: string | null) => {
      setScrollToMessageId(messageId);
      if (conversationId !== currentId) {
        setCurrentId(conversationId);
      } else if (messageId) {
        // Already on this conversation — scroll immediately
        requestAnimationFrame(() => {
          document
            .getElementById(`msg-${messageId}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      }
    },
    [currentId],
  );

  useEffect(() => {
    if (scrollToMessageId && messages.length > 0) {
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${scrollToMessageId}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
      const timer = setTimeout(() => setScrollToMessageId(null), 2500);
      return () => clearTimeout(timer);
    }
  }, [scrollToMessageId, messages]);

  const handleNewChat = () => {
    setCurrentId(null);
    setMessages([]);
    setInput("");
    setConversationCost(0);
    setReplyTo(null);
    setScrollToMessageId(null);
  };

  const handleDeleteChat = async (id: string) => {
    const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    // The backend cascade-deletes all descendants too.
    // If current chat was the deleted one or any of its descendants, reset.
    const updated = await fetch("/api/conversations");
    if (updated.ok) {
      const data = await updated.json();
      setConversations(data);
      if (currentId && !data.some((c: Conversation) => c.id === currentId)) {
        handleNewChat();
      }
    }
  };

  const handleBranch = async (messageIndex: number) => {
    if (!currentId || loading) return;
    try {
      const res = await fetch(`/api/conversations/${currentId}/branch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageIndex }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Branch failed");
        return;
      }
      const branch = await res.json();
      await fetchConversations();
      setCurrentId(branch.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Branch failed");
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const currentReplyTo = replyTo;
    setInput("");
    setReplyTo(null);
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      replyToId: currentReplyTo?.id ?? null,
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    const streamingAssistantId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      { id: streamingAssistantId, role: "assistant", content: "" },
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: currentId,
          message: text,
          model,
          replyToId: currentReplyTo?.id ?? undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessages((prev) => prev.filter((m) => m.id !== streamingAssistantId));
        alert(data.error ?? "Send failed");
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      if (!reader) {
        setMessages((prev) => prev.filter((m) => m.id !== streamingAssistantId));
        alert("Streaming not supported");
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let data: { type: string; text?: string; error?: string; conversationId?: string; message?: Message; usage?: { cost?: number } };
          try {
            data = JSON.parse(trimmed) as typeof data;
          } catch {
            continue;
          }
          if (data.type === "chunk" && typeof data.text === "string") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingAssistantId
                  ? { ...m, content: m.content + data.text }
                  : m
              )
            );
          } else if (data.type === "done" && data.conversationId != null && data.message) {
            setCurrentId(data.conversationId);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingAssistantId ? data.message! : m
              )
            );
            if (data.usage?.cost) {
              setConversationCost((prev) => prev + data.usage!.cost!);
            }
            await fetchConversations();
          } else if (data.type === "error") {
            setMessages((prev) => prev.filter((m) => m.id !== streamingAssistantId));
            alert(data.error ?? "Chat failed");
          }
        }
      }

      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer.trim()) as { type: string; error?: string; conversationId?: string; message?: Message; usage?: { cost?: number } };
          if (data.type === "done" && data.conversationId != null && data.message) {
            setCurrentId(data.conversationId);
            setMessages((prev) =>
              prev.map((m) =>
                m.id === streamingAssistantId ? data.message! : m
              )
            );
            if (data.usage?.cost) {
              setConversationCost((prev) => prev + data.usage!.cost!);
            }
            await fetchConversations();
          } else if (data.type === "error") {
            setMessages((prev) => prev.filter((m) => m.id !== streamingAssistantId));
            alert(data.error ?? "Chat failed");
          }
        } catch {
          // ignore final line parse errors
        }
      }
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== streamingAssistantId));
      alert(err instanceof Error ? err.message : "Send failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-screen flex">
      <Sidebar
        conversations={conversations}
        currentId={currentId}
        onSelect={setCurrentId}
        onNewChat={handleNewChat}
        onDelete={handleDeleteChat}
        onSearchSelect={handleSearchSelect}
      />
      <main className="flex-1 flex flex-col min-w-0">
        <header className="shrink-0 border-b border-[var(--border)] px-4 py-3 flex items-center justify-between">
          <h1 className="text-sm font-medium text-[var(--text-muted)]">
            OpenGrove
          </h1>
          {conversationCost > 0 && (
            <span className="text-xs font-mono text-[var(--text-muted)]">
              ${conversationCost < 0.01
                ? conversationCost.toFixed(6)
                : conversationCost.toFixed(4)}
            </span>
          )}
        </header>
        <div className="relative flex-1 flex flex-col min-h-0">
          <MessageList
            messages={messages}
            onBranch={currentId ? handleBranch : undefined}
            onReply={setReplyTo}
            highlightMessageId={scrollToMessageId}
          />
          <ChatInput
            value={input}
            onChange={setInput}
            onSend={handleSend}
            model={model}
            onModelChange={setModel}
            disabled={loading}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
          />
        </div>
      </main>
    </div>
  );
}
