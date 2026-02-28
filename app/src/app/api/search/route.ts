import { NextRequest, NextResponse } from "next/server";
import { searchMessages } from "@/lib/db";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (!q.trim()) {
    return NextResponse.json([]);
  }

  try {
    const results = searchMessages(q);
    return NextResponse.json(results);
  } catch (err) {
    console.error("Search failed:", err);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500 },
    );
  }
}
