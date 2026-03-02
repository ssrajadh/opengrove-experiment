import { NextRequest, NextResponse } from "next/server";
import { backfillSearchIndex } from "@/lib/search-indexer";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as { limit?: number };
    const limit = Math.min(body.limit ?? 100, 500);

    const result = await backfillSearchIndex(limit);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Backfill error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Backfill failed" },
      { status: 500 },
    );
  }
}
