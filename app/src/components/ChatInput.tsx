"use client";

import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUp, Plus, ChevronDown, X, MessageSquare } from "lucide-react";
import type { ClientMessage, Conversation } from "@/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { GEMINI_MODELS, OPENAI_MODELS } from "@/lib/model-constants";
import { cn } from "@/lib/utils";

type ModelOption = { id: string; label: string };

const LOCAL_MODELS: ModelOption[] = [
  { id: "local-model-placeholder", label: "Coming soon" },
];

function openAiLabel(modelId: string): string {
  const suffix = modelId.replace(/^gpt-/, "");
  const normalized = suffix.endsWith("-mini")
    ? `${suffix.replace(/-mini$/, "")} Mini`
    : suffix;
  return `GPT-${normalized}`;
}

function geminiLabel(modelId: string): string {
  const suffix = modelId.replace(/^gemini-/, "");
  return `Gemini ${suffix
    .split("-")
    .map((part) => {
      if (part === "flash") return "Flash";
      if (part === "lite") return "Lite";
      if (part === "pro") return "Pro";
      if (part === "preview") return "Preview";
      return part;
    })
    .join(" ")}`;
}

function parseHiddenModels(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

const OPENAI_MODEL_OPTIONS: ModelOption[] = OPENAI_MODELS.map((id) => ({
  id,
  label: openAiLabel(id),
}));

const GEMINI_MODEL_OPTIONS: ModelOption[] = Object.keys(GEMINI_MODELS).map((id) => ({
  id,
  label: geminiLabel(id),
}));

const MAX_ROWS = 6;
const LINE_HEIGHT = 20; // px, approximate for text-sm
const PADDING_Y = 16; // py-2 = 8px * 2

export type ContextRef = { id: string; title: string };

export default function ChatInput({
  value,
  onChange,
  onSend,
  model,
  onModelChange,
  disabled,
  replyTo,
  onCancelReply,
  conversations,
  currentConversationId,
  contextRefs,
  onAddContextRef,
  onRemoveContextRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  model: string;
  onModelChange: (v: string) => void;
  disabled?: boolean;
  replyTo?: ClientMessage | null;
  onCancelReply?: () => void;
  conversations?: Conversation[];
  currentConversationId?: string | null;
  contextRefs?: ContextRef[];
  onAddContextRef?: (ref: ContextRef) => void;
  onRemoveContextRef?: (id: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerFilter, setPickerFilter] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [localModelsEnabled, setLocalModelsEnabled] = useState(false);
  const [localRuntimeConfigured, setLocalRuntimeConfigured] = useState(false);
  const [localModelsFetchSucceeded, setLocalModelsFetchSucceeded] = useState(false);
  const [localModelOptions, setLocalModelOptions] = useState<ModelOption[]>([]);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
      // Auto-resize
      const ta = e.target;
      ta.style.height = "auto";
      const maxHeight = LINE_HEIGHT * MAX_ROWS + PADDING_Y;
      ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
    },
    [onChange]
  );

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const maxHeight = LINE_HEIGHT * MAX_ROWS + PADDING_Y;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, [value]);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  // Close picker on click outside
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
        setPickerFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  // Filter conversations for the picker
  const pickerConversations = useMemo(() => {
    if (!conversations) return [];
    const selectedIds = new Set((contextRefs ?? []).map((r) => r.id));
    return conversations
      .filter(
        (c) =>
          c.id !== currentConversationId &&
          !selectedIds.has(c.id) &&
          (!pickerFilter ||
            c.title.toLowerCase().includes(pickerFilter.toLowerCase())),
      )
      .slice(0, 20);
  }, [conversations, currentConversationId, contextRefs, pickerFilter]);

  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      try {
        const [settingsRes, localModelsRes] = await Promise.allSettled([
          fetch("/api/settings", { cache: "no-store" }),
          fetch("/api/local-models", { cache: "no-store" }),
        ]);

        let localHidden = new Set<string>();
        let enabled = false;
        let configured = false;

        if (settingsRes.status === "fulfilled" && settingsRes.value.ok) {
          const data = (await settingsRes.value.json()) as {
            openai_api_key?: unknown;
            gemini_api_key?: unknown;
            local_models_enabled?: unknown;
            local_endpoint?: unknown;
            local_models_hidden?: unknown;
          };
          if (cancelled) return;

          setHasOpenAiKey(
            typeof data.openai_api_key === "string" && data.openai_api_key.trim().length > 0
          );
          setHasGeminiKey(
            typeof data.gemini_api_key === "string" && data.gemini_api_key.trim().length > 0
          );

          enabled =
            typeof data.local_models_enabled === "string" &&
            ["1", "true", "yes", "on"].includes(data.local_models_enabled.trim().toLowerCase());
          configured =
            typeof data.local_endpoint === "string" && data.local_endpoint.trim().length > 0;
          localHidden = new Set(parseHiddenModels(data.local_models_hidden));

          setLocalModelsEnabled(enabled);
          setLocalRuntimeConfigured(configured);
        }

        if (localModelsRes.status === "fulfilled" && localModelsRes.value.ok) {
          const data = (await localModelsRes.value.json()) as {
            models?: unknown;
            error?: unknown;
          };
          if (cancelled) return;

          if (!data.error && Array.isArray(data.models) && enabled) {
            const options = data.models
              .filter((item): item is string => typeof item === "string")
              .filter((id) => !localHidden.has(id))
              .map((id) => ({ id: `local:${id}`, label: id }));
            setLocalModelOptions(options);
            setLocalModelsFetchSucceeded(true);
          } else {
            setLocalModelOptions([]);
            setLocalModelsFetchSucceeded(false);
          }
        } else {
          if (cancelled) return;
          setLocalModelOptions([]);
          setLocalModelsFetchSucceeded(false);
        }
      } catch {
        // Ignore settings fetch errors; keep provider models disabled by default.
      }
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, []);

  const currentModelLabel = useMemo(() => {
    const allModels = [
      ...OPENAI_MODEL_OPTIONS,
      ...GEMINI_MODEL_OPTIONS,
      ...localModelOptions,
      ...LOCAL_MODELS,
    ];
    return allModels.find((m) => m.id === model)?.label ?? model;
  }, [localModelOptions, model]);

  return (
    <div className="absolute inset-x-0 bottom-0 z-20">
      <div className="mx-auto w-full max-w-5xl px-4 py-3 flex flex-col items-stretch gap-2">
        {/* Reply preview bar */}
        {replyTo && (
          <div className="flex items-center gap-2 rounded-2xl border border-zinc-700/60 bg-zinc-800/90 px-4 py-2">
            <div className="flex-1 min-w-0 border-l-2 border-zinc-500 pl-3">
              <p className="text-xs text-zinc-400 mb-0.5">
                Replying to {replyTo.role === "user" ? "yourself" : "assistant"}
              </p>
              <p className="text-xs text-zinc-500 truncate">
                {replyTo.content.length > 100
                  ? replyTo.content.slice(0, 100) + "..."
                  : replyTo.content}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 rounded-full text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700"
              onClick={onCancelReply}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {/* Context ref chips */}
        {contextRefs && contextRefs.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {contextRefs.map((ref) => (
              <span
                key={ref.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-800/90 px-3 py-1 text-xs text-zinc-300"
              >
                <MessageSquare className="h-3 w-3 text-zinc-500" />
                <span className="max-w-[160px] truncate">{ref.title}</span>
                <button
                  onClick={() => onRemoveContextRef?.(ref.id)}
                  className="text-zinc-500 hover:text-zinc-300"
                  aria-label={`Remove ${ref.title}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* Input capsule */}
        <div className="relative flex w-full items-end gap-2 rounded-3xl border border-zinc-700/60 bg-zinc-900/95 pl-1.5 pr-1.5 py-1.5 focus-within:border-zinc-600 transition-colors">
          {/* Plus button — attach context from another conversation */}
          <div className="relative" ref={pickerRef}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-8 w-8 shrink-0 rounded-full text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800",
                    pickerOpen && "bg-zinc-800 text-zinc-200",
                  )}
                  onClick={() => {
                    setPickerOpen(!pickerOpen);
                    setPickerFilter("");
                  }}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              {!pickerOpen && (
                <TooltipContent side="top">
                  Add context from another chat
                </TooltipContent>
              )}
            </Tooltip>

            {/* Conversation picker */}
            {pickerOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl z-30">
                <div className="p-2">
                  <input
                    type="text"
                    value={pickerFilter}
                    onChange={(e) => setPickerFilter(e.target.value)}
                    placeholder="Filter conversations..."
                    autoFocus
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-500 focus:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto px-1 pb-1">
                  {pickerConversations.length === 0 && (
                    <p className="px-3 py-3 text-xs text-zinc-500">
                      {conversations && conversations.length > 0
                        ? "No matching conversations"
                        : "No other conversations"}
                    </p>
                  )}
                  {pickerConversations.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        onAddContextRef?.({ id: c.id, title: c.title });
                        setPickerOpen(false);
                        setPickerFilter("");
                      }}
                      className="w-full text-left rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors truncate"
                    >
                      {c.title || "New chat"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Textarea
            ref={textareaRef}
            value={value}
            onChange={handleInput}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder="Message..."
            rows={1}
            disabled={disabled}
            className="flex-1 resize-none overflow-y-auto border-0 bg-transparent p-0 py-1 text-sm text-zinc-100 placeholder:text-zinc-500 shadow-none focus-visible:ring-0 min-h-0 max-h-[136px] leading-5"
          />

          {/* Send button */}
          <Button
            onClick={onSend}
            disabled={disabled || !value.trim()}
            size="icon"
            className={cn(
              "h-8 w-8 shrink-0 rounded-full transition-colors",
              value.trim() && !disabled
                ? "bg-zinc-100 text-zinc-900 hover:bg-white"
                : "bg-zinc-700 text-zinc-400"
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>

        {/* Model selector pill below */}
        <div className="flex items-center">
          <TooltipProvider>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-zinc-900/65 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-300 hover:border-zinc-600 transition-colors focus:outline-none">
                  {currentModelLabel}
                  <ChevronDown className="h-3 w-3 opacity-95" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="bg-zinc-900 border-zinc-700 min-w-[240px]">
                <DropdownMenuRadioGroup value={model} onValueChange={onModelChange}>
                  <DropdownMenuLabel className="text-zinc-400">OpenAI</DropdownMenuLabel>
                  {OPENAI_MODEL_OPTIONS.map((m) => {
                    const disabledItem = !hasOpenAiKey;
                    const item = (
                      <DropdownMenuRadioItem
                        key={m.id}
                        value={m.id}
                        disabled={disabledItem}
                        className={cn(
                          "text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100",
                          disabledItem ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                        )}
                      >
                        {m.label}
                      </DropdownMenuRadioItem>
                    );

                    if (!disabledItem) return item;

                    return (
                      <Tooltip key={m.id}>
                        <TooltipTrigger asChild>
                          <div>{item}</div>
                        </TooltipTrigger>
                        <TooltipContent>
                          Add your OpenAI API key in Settings to use these models
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}

                  <DropdownMenuSeparator className="bg-zinc-800" />
                  <DropdownMenuLabel className="text-zinc-400">Google Gemini</DropdownMenuLabel>
                  {GEMINI_MODEL_OPTIONS.map((m) => {
                    const disabledItem = !hasGeminiKey;
                    const item = (
                      <DropdownMenuRadioItem
                        key={m.id}
                        value={m.id}
                        disabled={disabledItem}
                        className={cn(
                          "text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100",
                          disabledItem ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                        )}
                      >
                        {m.label}
                      </DropdownMenuRadioItem>
                    );

                    if (!disabledItem) return item;

                    return (
                      <Tooltip key={m.id}>
                        <TooltipTrigger asChild>
                          <div>{item}</div>
                        </TooltipTrigger>
                        <TooltipContent>
                          Add your Google Gemini API key in Settings to use these models
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}

                  <DropdownMenuSeparator className="bg-zinc-800" />
                  <DropdownMenuLabel className="text-zinc-400">Local Models</DropdownMenuLabel>
                  {localModelsEnabled && localModelsFetchSucceeded
                    ? localModelOptions.map((m) => (
                        <DropdownMenuRadioItem
                          key={m.id}
                          value={m.id}
                          className="text-zinc-300 focus:bg-zinc-800 focus:text-zinc-100 cursor-pointer"
                        >
                          {m.label}
                        </DropdownMenuRadioItem>
                      ))
                    : LOCAL_MODELS.map((m) => (
                        <Tooltip key={m.id}>
                          <TooltipTrigger asChild>
                            <div>
                              <DropdownMenuRadioItem
                                value={m.id}
                                disabled
                                className="text-zinc-300 opacity-50 cursor-not-allowed"
                              >
                                {m.label}
                              </DropdownMenuRadioItem>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            {localRuntimeConfigured && !localModelsEnabled
                              ? "Enable local models in Settings"
                              : "Local model support coming soon"}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}
