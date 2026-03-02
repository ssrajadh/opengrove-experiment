import { NextRequest, NextResponse } from "next/server";
import { searchMessages, searchChunksGlobal, vecLoaded } from "@/lib/db";
import { embedText, ensureEmbeddingConfig } from "@/lib/embeddings";
import type { SearchResult } from "@/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const { query } = (await req.json()) as { query: string };

  if (!query || query.trim().length < 2) {
    return NextResponse.json([]);
  }

  const trimmed = query.trim();
  const results: SearchResult[] = [];
  const seenMessageIds = new Set<string>();

  // Leg 1: text search (covers all messages including recent unembedded)
  const textResults = searchMessages(trimmed, 20);
  for (const r of textResults) {
    if (!seenMessageIds.has(r.messageId)) {
      seenMessageIds.add(r.messageId);
      results.push(r);
    }
  }

  // Leg 2: vector search (semantic, for embedded overflow messages)
  if (vecLoaded && process.env.OPENAI_API_KEY && trimmed.length >= 10) {
    try {
      await ensureEmbeddingConfig();
      const queryEmbedding = await embedText(trimmed);
      const embeddingVec = new Float32Array(queryEmbedding);
      const vectorResults = searchChunksGlobal(embeddingVec, 10);

      for (const r of vectorResults) {
        if (!seenMessageIds.has(r.messageId)) {
          seenMessageIds.add(r.messageId);
          results.push(r);
        }
      }
    } catch (err) {
      console.error("Vector search failed:", err);
    }
  }

  results.sort((a, b) => a.score - b.score);
  return NextResponse.json(results.slice(0, 15));
}
