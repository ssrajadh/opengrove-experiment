import { NextRequest, NextResponse } from "next/server";
import { vecLoaded, querySearchEmbeddings, getConversation } from "@/lib/db";
import { embedText, ensureEmbeddingConfig } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ results: [] });
  }

  if (!vecLoaded) {
    return NextResponse.json(
      { error: "Vector search not available" },
      { status: 503 },
    );
  }

  try {
    await ensureEmbeddingConfig();

    const queryEmbedding = await embedText(q);
    const embeddingVec = new Float32Array(queryEmbedding);

    const k = parseInt(req.nextUrl.searchParams.get("k") ?? "10", 10);
    const results = querySearchEmbeddings(embeddingVec, Math.min(k, 50));

    const enriched = await Promise.all(
      results.map(async (r) => {
        const conv = await getConversation(r.conversation_id);
        return {
          messageId: r.message_id,
          conversationId: r.conversation_id,
          conversationTitle: conv?.title ?? "Unknown",
          role: r.role,
          contentPreview: r.content_preview,
          distance: r.distance,
        };
      }),
    );

    return NextResponse.json({ results: enriched });
  } catch (err) {
    console.error("Search API error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 },
    );
  }
}
