"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { Search, X, Loader2 } from "lucide-react";
import type { Conversation, SearchResult } from "@/types";
import ConfirmModal from "./ConfirmModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

type ConversationNode = Conversation & { children: ConversationNode[] };

/** Build a tree from a flat list using parent_id. */
function buildTree(conversations: Conversation[]): ConversationNode[] {
  const map = new Map<string, ConversationNode>();
  for (const c of conversations) {
    map.set(c.id, { ...c, children: [] });
  }
  const roots: ConversationNode[] = [];
  for (const node of Array.from(map.values())) {
    if (node.parent_id && map.has(node.parent_id)) {
      map.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort children newest-first
  for (const node of Array.from(map.values())) {
    node.children.sort(
      (a: ConversationNode, b: ConversationNode) => b.created_at - a.created_at
    );
  }
  return roots;
}

export default function Sidebar({
  conversations,
  currentId,
  onSelect,
  onNewChat,
  onDelete,
  onNavigateToMessage,
}: {
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onNavigateToMessage: (conversationId: string, messageId: string) => void;
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tree = useMemo(() => buildTree(conversations), [conversations]);

  // Close menu on outside click
  useEffect(() => {
    if (!openMenuId) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMenuId]);

  // Debounced search
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    const query = searchQuery.trim();
    if (!query || query.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&k=10`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data.results ?? []);
        }
      } catch {
        // Silently fail
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [searchQuery]);

  // Ctrl/Cmd+K to open search, Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && showSearch) {
        setShowSearch(false);
        setSearchQuery("");
        setSearchResults([]);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showSearch]);

  // One-time backfill of search index on mount
  useEffect(() => {
    let cancelled = false;
    async function runBackfill() {
      try {
        while (!cancelled) {
          const res = await fetch("/api/search/backfill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ limit: 100 }),
          });
          if (!res.ok) break;
          const data = await res.json();
          if (data.remaining === 0 || data.indexed === 0) break;
        }
      } catch {
        // Silently fail — backfill is best-effort
      }
    }
    runBackfill();
    return () => { cancelled = true; };
  }, []);

  const clearSearch = useCallback(() => {
    setShowSearch(false);
    setSearchQuery("");
    setSearchResults([]);
  }, []);

  function renderItem(c: ConversationNode, depth: number) {
    const isActive = currentId === c.id;
    const hasChildren = c.children.length > 0;
    const isCollapsed = collapsedIds.has(c.id);
    const isMenuOpen = openMenuId === c.id;

    return (
      <div key={c.id} className="w-full min-w-0">
        {/* FIX: added overflow-hidden to prevent flex children from expanding
            the row beyond its bounds, which breaks text-ellipsis */}
        <div
          className={cn(
            "group flex w-full min-w-0 overflow-hidden items-center gap-1 rounded-md text-sm transition-colors",
            isActive
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          )}
          style={{ paddingLeft: `${Math.min(depth, 4) * 16 + 4}px` }}
        >
          {depth > 0 && (
            <span className="text-zinc-600 text-xs mr-0.5 shrink-0 select-none">
              ⑂
            </span>
          )}

          {/* Collapse/expand toggle */}
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setCollapsedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.id)) {
                    next.delete(c.id);
                  } else {
                    next.add(c.id);
                  }
                  return next;
                });
              }}
              className="shrink-0 rounded-sm px-1 py-0.5 text-xs text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
              aria-label={isCollapsed ? "Expand subchats" : "Collapse subchats"}
              title={isCollapsed ? "Expand subchats" : "Collapse subchats"}
            >
              <svg
                viewBox="0 0 16 16"
                className={cn(
                  "h-3.5 w-3.5 text-current transition-transform",
                  isCollapsed ? "-rotate-90" : "rotate-0"
                )}
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <polyline points="2.5,5.5 8,11 13.5,5.5" />
              </svg>
            </button>
          ) : (
            <span className="w-4 shrink-0" aria-hidden />
          )}

          {/* Title button — flex-1 + min-w-0 allows truncation to work */}
          <button
            onClick={() => onSelect(c.id)}
            className="flex-1 min-w-0 px-2 py-1.5 text-left"
            title={c.title || "New chat"}
          >
            {/* FIX: block + w-full + overflow-hidden + truncation classes
                all together. The parent must also have overflow-hidden (above). */}
            <span className="block w-full overflow-hidden text-ellipsis whitespace-nowrap">
              {c.title || "New chat"}
            </span>
          </button>

          {/* Three-dot menu — FIX: hidden by default, revealed on row hover
              or when the menu is open or the row is active */}
          <div
            className="relative shrink-0"
            ref={isMenuOpen ? menuRef : undefined}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenuId(isMenuOpen ? null : c.id);
              }}
              className={cn(
                "rounded-md p-1.5 text-zinc-300 hover:bg-zinc-700 transition-opacity",
                // Hidden by default; shown on group hover, when active, or when menu is open
                isMenuOpen || isActive
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100"
              )}
              aria-label="Menu"
              aria-haspopup="menu"
            >
              <span className="block text-base leading-none">⋮</span>
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 top-full mt-1 py-1 rounded-md bg-zinc-800 border border-zinc-700 shadow-xl z-10 min-w-[130px]">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(null);
                    if (c.children.length > 0) {
                      setConfirmDeleteId(c.id);
                    } else {
                      onDelete(c.id);
                    }
                  }}
                  className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700/70 rounded-sm transition-colors"
                >
                  Delete chat
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Children */}
        {hasChildren && !isCollapsed && (
          <div className="ml-4 min-w-0 border-l border-zinc-700/60 pl-1">
            {c.children.map((child) => renderItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  const hasActiveSearch = searchQuery.trim().length >= 2;

  return (
    <aside className="w-72 shrink-0 border-r border-zinc-800 bg-zinc-900 flex flex-col">
      <div className="p-3">
        <Button
          onClick={onNewChat}
          variant="outline"
          className="w-full justify-start gap-2 border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New chat
        </Button>
      </div>

      {/* Search bar */}
      <div className="px-3 pb-2">
        {showSearch ? (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search messages..."
              className="h-8 pl-8 pr-8 text-xs bg-zinc-800/60 border-zinc-700 text-zinc-200 placeholder:text-zinc-500"
            />
            <button
              onClick={() => {
                if (searchQuery) {
                  setSearchQuery("");
                  setSearchResults([]);
                } else {
                  clearSearch();
                }
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
            >
              {isSearching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <X className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        ) : (
          <Button
            onClick={() => {
              setShowSearch(true);
              setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 h-8 text-xs"
          >
            <Search className="h-3.5 w-3.5" />
            Search
            <kbd className="ml-auto text-[10px] text-zinc-600 bg-zinc-800 px-1.5 py-0.5 rounded">
              {typeof navigator !== "undefined" && navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl"}K
            </kbd>
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1">
        {searchResults.length > 0 ? (
          <div className="px-2 pb-2">
            <p className="text-[10px] text-zinc-500 px-2 py-1 uppercase tracking-wider">
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
            </p>
            {searchResults.map((result) => (
              <button
                key={result.messageId}
                onClick={() => {
                  onNavigateToMessage(result.conversationId, result.messageId);
                  clearSearch();
                }}
                className="w-full text-left px-2 py-2 rounded-md text-sm hover:bg-zinc-800/60 transition-colors"
              >
                <p className="text-[10px] text-zinc-500 mb-0.5 truncate">
                  {result.conversationTitle}
                </p>
                <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">
                  <span className="text-zinc-500 font-medium">
                    {result.role === "user" ? "You: " : "AI: "}
                  </span>
                  {result.contentPreview}
                </p>
              </button>
            ))}
          </div>
        ) : hasActiveSearch && !isSearching ? (
          <p className="text-zinc-500 text-xs px-4 py-4">No results found</p>
        ) : (
          <nav className="min-w-0 px-2 pb-2">
            {conversations.length === 0 && (
              <p className="text-zinc-500 text-xs px-2 py-4">
                No conversations yet
              </p>
            )}
            {tree.map((c) => renderItem(c, 0))}
          </nav>
        )}
      </ScrollArea>

      <div className="border-t border-zinc-800 p-3">
        <Button
          asChild
          variant="ghost"
          className="w-full justify-start gap-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <Link href="/settings">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-.4-1.1 1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.8a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.1-.4 1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.8a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 .4 1.1 1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.24.33.4.72.46 1.13.05.41-.01.83-.18 1.21a1.7 1.7 0 0 0 0 1.32c.17.38.23.8.18 1.21-.06.41-.22.8-.46 1.13Z" />
            </svg>
            Settings
          </Link>
        </Button>
      </div>

      {confirmDeleteId && (
        <ConfirmModal
          title="Delete chat and subchats"
          message="Deleting this chat will also delete all subchats below it. Are you sure?"
          confirmLabel="Delete all"
          onConfirm={() => {
            onDelete(confirmDeleteId);
            setConfirmDeleteId(null);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </aside>
  );
}
