import { NextRequest, NextResponse } from "next/server";
import {
  vecLoaded,
  getAllConversationIds,
  searchMessagesByText,
  getConversationTitleMap,
  queryChunks,
  getSettings,
} from "@/lib/db";
import { embedText, ensureEmbeddingConfig } from "@/lib/embeddings";
import type { SearchResult } from "@/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { query?: string };
    const query = body.query?.trim();

    if (!query || query.length === 0) {
      return NextResponse.json({ results: [] });
    }

    const results: SearchResult[] = [];
    const seenMessageIds = new Set<string>();

    // --- Phase 1: Semantic (vector) search ---
    const settings = getSettings();
    const hasOpenAiKey = Boolean(
      settings.openai_api_key?.trim() || process.env.OPENAI_API_KEY
    );

    if (vecLoaded && hasOpenAiKey) {
      try {
        await ensureEmbeddingConfig();
        const allIds = await getAllConversationIds();
        if (allIds.length > 0) {
          const queryEmbedding = await embedText(query);
          const embeddingVec = new Float32Array(queryEmbedding);
          const vectorResults = queryChunks(allIds, embeddingVec, 10);

          const convIds = Array.from(new Set(vectorResults.map((r) => r.conversation_id)));
          const titleMap = await getConversationTitleMap(convIds);

          for (const chunk of vectorResults) {
            const score = Math.max(0, 1 - chunk.distance);
            const role = chunk.chunk_text.startsWith("ASSISTANT:") ? "assistant" as const : "user" as const;
            const snippet =
              chunk.chunk_text.length > 200
                ? chunk.chunk_text.slice(0, 200) + "..."
                : chunk.chunk_text;

            results.push({
              messageId: null,
              conversationId: chunk.conversation_id,
              conversationTitle: titleMap.get(chunk.conversation_id) ?? "Untitled",
              role,
              snippet,
              relevanceType: "semantic",
              score,
            });
          }
        }
      } catch (err) {
        console.error("Semantic search failed, falling back to text only:", err);
      }
    }

    // --- Phase 2: Text (SQL) search ---
    const textResults = await searchMessagesByText(query, 20);
    const textConvIds = Array.from(new Set(textResults.map((r) => r.conversation_id)));
    const textTitleMap = await getConversationTitleMap(textConvIds);

    for (const row of textResults) {
      if (seenMessageIds.has(row.id)) continue;
      seenMessageIds.add(row.id);

      const lowerContent = row.content.toLowerCase();
      const lowerQuery = query.toLowerCase();
      const matchIdx = lowerContent.indexOf(lowerQuery);

      let snippet: string;
      if (matchIdx >= 0) {
        const start = Math.max(0, matchIdx - 60);
        const end = Math.min(row.content.length, matchIdx + query.length + 140);
        snippet =
          (start > 0 ? "..." : "") +
          row.content.slice(start, end) +
          (end < row.content.length ? "..." : "");
      } else {
        snippet =
          row.content.length > 200
            ? row.content.slice(0, 200) + "..."
            : row.content;
      }

      results.push({
        messageId: row.id,
        conversationId: row.conversation_id,
        conversationTitle: textTitleMap.get(row.conversation_id) ?? "Untitled",
        role: row.role,
        snippet,
        relevanceType: "text",
        score: 0.7,
      });
    }

    // Sort by score descending, limit to 20
    results.sort((a, b) => b.score - a.score);

    return NextResponse.json({ results: results.slice(0, 20) });
  } catch (err) {
    console.error("Search API error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 },
    );
  }
}
