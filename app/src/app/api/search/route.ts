import { NextRequest, NextResponse } from "next/server";
import { hybridSearch } from "@/lib/search";
import { getConversation } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q")?.trim();
  if (!query || query.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "10", 10) || 10, 1), 50);

  try {
    const results = await hybridSearch(query, limit);

    const enriched = await Promise.all(
      results.map(async (r) => {
        const convo = await getConversation(r.conversationId);
        return {
          ...r,
          conversationTitle: convo?.title ?? "Unknown",
        };
      })
    );

    return NextResponse.json({ results: enriched });
  } catch (err) {
    console.error("Search API error:", err);
    return NextResponse.json(
      { error: "Search failed", results: [] },
      { status: 500 }
    );
  }
}
