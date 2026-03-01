import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai/index.mjs";
import { GEMINI_MODELS, OPENAI_MODELS, calculateCost } from "@/lib/model-constants";
import {
  insertMessage,
  insertUsage,
  getMessage,
  getFullHistory,
  getConversation,
  createConversation,
  getSettings,
} from "@/lib/db";
import { estimateTokens } from "@/lib/tokens";
import { buildContextWithRAG } from "@/lib/rag";
import { embedAndStoreOverflow } from "@/lib/embeddings";
import { redactPII } from "@/lib/pii";
import { randomUUID } from "crypto";
/** Context window sizes in tokens per model. */
const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  // Gemini
  "gemini-2.0-flash":       1_048_576,
  "gemini-2.0-flash-lite":  1_048_576,
  "gemini-3-flash-preview": 1_048_576,
  "gemini-3-pro-preview":   1_048_576,
  // OpenAI
  "gpt-4o":      128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1":     1_047_576,
  "gpt-4.1-mini":1_047_576,
};

const RESPONSE_BUFFER_TOKENS = 4096;

function isOpenAIModel(modelKey: string): boolean {
  return OPENAI_MODELS.includes(modelKey) || modelKey.startsWith("gpt-");
}

function isLocalModel(modelKey: string): boolean {
  return modelKey.startsWith("local:");
}

function streamLine(obj: object): string {
  return JSON.stringify(obj) + "\n";
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      conversationId: string | null;
      message: string;
      model: string;
      replyToId?: string | null;
      contextRefs?: string[];
    };
    const { conversationId, message: messageText, model: modelKey, replyToId, contextRefs } = body;

    const id = conversationId ?? randomUUID();

    if (!conversationId) {
      const modelId = isOpenAIModel(modelKey)
        ? modelKey
        : GEMINI_MODELS[modelKey] ?? "gemini-2.0-flash";
      await createConversation(id, modelId, messageText.slice(0, 80) || "New chat");
    }

    const userMsgId = randomUUID();
    await insertMessage(userMsgId, id, "user", messageText, replyToId);

    // Look up the quoted message content for reply context
    let replyContext: string | null = null;
    if (replyToId) {
      const quotedMsg = await getMessage(replyToId);
      if (quotedMsg) {
        const truncated = quotedMsg.content.length > 300
          ? quotedMsg.content.slice(0, 300) + "..."
          : quotedMsg.content;
        replyContext = `[Replying to ${quotedMsg.role}: "${truncated}"]`;
      }
    }

    const settings = getSettings();

    const allMessages = await getFullHistory(id);

    // ---- Cross-conversation context injection ----
    const crossConvPreamble: Array<{ role: "user" | "assistant"; content: string }> = [];
    let crossConvTokens = 0;

    if (contextRefs && contextRefs.length > 0) {
      const rawLimit = MODEL_CONTEXT_TOKENS[modelKey] ?? 32_768;
      const available = rawLimit - RESPONSE_BUFFER_TOKENS;
      const maxCrossConvTokens = Math.floor(available * 0.3);

      for (let idx = 0; idx < contextRefs.length; idx++) {
        if (crossConvTokens >= maxCrossConvTokens) break;
        const refId = contextRefs[idx];

        const refConversation = await getConversation(refId);
        if (!refConversation) continue;

        const refHistory = await getFullHistory(refId);
        if (refHistory.length === 0) continue;

        const refTitle = refConversation.title || "Untitled";
        const remaining = contextRefs.length - idx;
        const perConvBudget = Math.floor((maxCrossConvTokens - crossConvTokens) / remaining);

        // Take the most recent messages that fit within budget
        let formatted = "";
        let tokenCount = 0;
        for (let i = refHistory.length - 1; i >= 0; i--) {
          const msg = refHistory[i];
          const line = `${msg.role.toUpperCase()}: ${msg.content}\n`;
          const lineTokens = estimateTokens(line);
          if (tokenCount + lineTokens > perConvBudget) break;
          formatted = line + formatted;
          tokenCount += lineTokens;
        }

        if (formatted.trim()) {
          crossConvPreamble.push(
            { role: "user", content: `Context from conversation "${refTitle}":\n${formatted.trim()}` },
            { role: "assistant", content: "Understood, I have that context." },
          );
          crossConvTokens += tokenCount + estimateTokens(`Context from conversation "${refTitle}":\nUnderstood, I have that context.`);
        }
      }
    }

    const contextLimit = (MODEL_CONTEXT_TOKENS[modelKey] ?? 32_768) - crossConvTokens;
    const { ragContext, recentMessages, overflow } = await buildContextWithRAG(
      id, allMessages, messageText, contextLimit, RESPONSE_BUFFER_TOKENS,
    );

    // Build provider-ready history
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    // Cross-conversation context first
    for (const entry of crossConvPreamble) {
      history.push(entry);
    }

    // RAG preamble
    if (ragContext) {
      history.push(
        { role: "user", content: "Relevant context from earlier in this conversation:\n" + ragContext },
        { role: "assistant", content: "Understood, I have that context." },
      );
    }

    // Recent messages
    for (const m of recentMessages) {
      history.push({ role: m.role, content: m.content });
    }

    // Prepend reply context to the final user message so the model knows what's being referenced
    if (replyContext && history.length > 0) {
      const last = history[history.length - 1];
      if (last.role === "user") {
        last.content = replyContext + "\n\n" + last.content;
      }
    }

    // PII redaction: scrub sensitive data before sending to cloud APIs
    if (settings.pii_redaction_enabled === "true" && !isLocalModel(modelKey)) {
      for (const entry of history) {
        entry.content = redactPII(entry.content);
      }
    }

    const assistantMsgId = randomUUID();

    const encoder = new TextEncoder();
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: object) => {
          controller.enqueue(encoder.encode(streamLine(obj)));
        };

        try {
          if (isOpenAIModel(modelKey)) {
            const apiKey = settings.openai_api_key?.trim() || process.env.OPENAI_API_KEY;
            if (!apiKey) {
              send({ type: "error", error: "OpenAI API key not set. Add it in Settings or .env" });
              controller.close();
              return;
            }
            const openai = new OpenAI({ apiKey });
            const input = history.map((m) => ({
              role: m.role === "user" ? ("user" as const) : ("assistant" as const),
              content: m.content,
            }));
            const streamResponse = await openai.responses.create({
              model: modelKey,
              input,
              stream: true,
              tools: [
                {
                  type: "web_search_preview",
                  search_context_size: "medium",
                },
              ],
            });
            for await (const event of streamResponse) {
              if (
                event.type === "response.output_text.delta" &&
                event.delta
              ) {
                fullText += event.delta;
                send({ type: "chunk", text: event.delta });
              } else if (event.type === "response.completed" && event.response?.usage) {
                inputTokens = event.response.usage.input_tokens ?? 0;
                outputTokens = event.response.usage.output_tokens ?? 0;
              }
            }
          } else if (isLocalModel(modelKey)) {
            const endpoint = settings.local_endpoint?.trim();
            if (!endpoint) {
              send({ type: "error", error: "No local endpoint configured" });
              controller.close();
              return;
            }

            const modelId = modelKey.slice("local:".length);
            const baseURL = `${endpoint.replace(/\/+$/, "")}/v1`;
            const openai = new OpenAI({ baseURL, apiKey: "local" });
            const streamResponse = await openai.chat.completions.create({
              model: modelId,
              messages: history.map((m) => ({
                role: m.role,
                content: m.content,
              })),
              stream: true,
            });

            for await (const chunk of streamResponse) {
              const text = chunk.choices?.[0]?.delta?.content ?? "";
              if (text) {
                fullText += text;
                send({ type: "chunk", text });
              }
              if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens ?? 0;
                outputTokens = chunk.usage.completion_tokens ?? 0;
              }
            }
          } else {
            const apiKey = settings.gemini_api_key?.trim() || process.env.GEMINI_API_KEY;
            if (!apiKey) {
              send({ type: "error", error: "Gemini API key not set. Add it in Settings or .env" });
              controller.close();
              return;
            }
            const modelId = GEMINI_MODELS[modelKey] ?? "gemini-2.0-flash";
            const ai = new GoogleGenAI({ apiKey });
            const contents = history.map((m) => ({
              role: m.role === "user" ? "user" : "model",
              parts: [{ text: m.content }],
            }));
            const streamResult = await ai.models.generateContentStream({
              model: modelId,
              contents,
              config: {
                tools: [{ googleSearch: {} }],
              },
            });
            for await (const chunk of streamResult) {
              const text = chunk.text ?? "";
              if (text) {
                fullText += text;
                send({ type: "chunk", text });
              }
              if (chunk.usageMetadata) {
                inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
                outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
              }
            }
          }

          const text = fullText.trim();
          await insertMessage(assistantMsgId, id, "assistant", text);

          // Fallback: estimate tokens if the provider didn't report usage
          if (inputTokens === 0 && outputTokens === 0) {
            inputTokens = estimateTokens(history.map((m) => m.content).join(""));
            outputTokens = estimateTokens(text);
          }
          const cost = calculateCost(modelKey, inputTokens, outputTokens);
          await insertUsage(randomUUID(), id, assistantMsgId, modelKey, inputTokens, outputTokens, cost);

          // Fire-and-forget: embed overflow messages for future RAG retrieval
          if (overflow.length > 0) {
            embedAndStoreOverflow(id, overflow).catch((err) =>
              console.error("Background embedding failed:", err),
            );
          }

          send({
            type: "done",
            conversationId: id,
            message: { role: "assistant" as const, content: text, id: assistantMsgId },
            usage: { inputTokens, outputTokens, cost },
          });
        } catch (err) {
          console.error("Chat API error:", err);
          send({
            type: "error",
            error: err instanceof Error ? err.message : "Chat failed",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("Chat API error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Chat failed" },
      { status: 500 }
    );
  }
}
