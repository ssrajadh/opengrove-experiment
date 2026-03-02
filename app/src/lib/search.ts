import { embedText, ensureEmbeddingConfig, embedTexts, EMBEDDING_DIMENSIONS } from "@/lib/embeddings";
import {
  searchEmbeddings,
  searchFTS,
  getUnindexedSearchMessages,
  insertSearchEmbedding,
  createSearchEmbeddingsTable,
  vecLoaded,
  type SearchHit,
  type FTSHit,
} from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SearchResult = {
  messageId: string;
  conversationId: string;
  role: string;
  contentPreview: string;
  score: number;
  matchType: "semantic" | "keyword" | "hybrid";
};

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

const RRF_K = 60;

function reciprocalRankFusion(
  semanticHits: SearchHit[],
  ftsHits: FTSHit[],
  topK: number,
): SearchResult[] {
  const scores = new Map<string, {
    score: number;
    conversationId: string;
    role: string;
    contentPreview: string;
    inSemantic: boolean;
    inKeyword: boolean;
  }>();

  for (let i = 0; i < semanticHits.length; i++) {
    const hit = semanticHits[i];
    const rrf = 1 / (RRF_K + i + 1);
    scores.set(hit.message_id, {
      score: rrf,
      conversationId: hit.conversation_id,
      role: hit.role,
      contentPreview: hit.content_preview,
      inSemantic: true,
      inKeyword: false,
    });
  }

  for (let i = 0; i < ftsHits.length; i++) {
    const hit = ftsHits[i];
    const rrf = 1 / (RRF_K + i + 1);
    const existing = scores.get(hit.id);
    if (existing) {
      existing.score += rrf;
      existing.inKeyword = true;
    } else {
      scores.set(hit.id, {
        score: rrf,
        conversationId: hit.conversation_id,
        role: hit.role,
        contentPreview: hit.content.slice(0, 200),
        inSemantic: false,
        inKeyword: true,
      });
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK)
    .map(([messageId, data]) => ({
      messageId,
      conversationId: data.conversationId,
      role: data.role,
      contentPreview: data.contentPreview,
      score: data.score,
      matchType: data.inSemantic && data.inKeyword
        ? "hybrid"
        : data.inSemantic
          ? "semantic"
          : "keyword",
    }));
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

export async function backfillSearchEmbeddings(): Promise<number> {
  if (!vecLoaded) return 0;

  await ensureEmbeddingConfig();
  createSearchEmbeddingsTable(EMBEDDING_DIMENSIONS);

  const unindexed = getUnindexedSearchMessages();
  if (unindexed.length === 0) return 0;

  let indexed = 0;
  for (let i = 0; i < unindexed.length; i += BATCH_SIZE) {
    const batch = unindexed.slice(i, i + BATCH_SIZE);
    const texts = batch.map((m) => `${m.role.toUpperCase()}: ${m.content}`);
    const embeddings = await embedTexts(texts);

    for (let j = 0; j < batch.length; j++) {
      const msg = batch[j];
      insertSearchEmbedding(
        msg.id,
        msg.conversation_id,
        msg.role,
        msg.content.slice(0, 200),
        new Float32Array(embeddings[j]),
      );
    }
    indexed += batch.length;
  }

  return indexed;
}

// ---------------------------------------------------------------------------
// Incremental index (for new messages)
// ---------------------------------------------------------------------------

export async function indexMessageForSearch(
  messageId: string,
  conversationId: string,
  role: string,
  content: string,
): Promise<void> {
  if (!vecLoaded) return;

  try {
    await ensureEmbeddingConfig();
    createSearchEmbeddingsTable(EMBEDDING_DIMENSIONS);

    const text = `${role.toUpperCase()}: ${content}`;
    const embedding = await embedText(text);
    insertSearchEmbedding(
      messageId,
      conversationId,
      role,
      content.slice(0, 200),
      new Float32Array(embedding),
    );
  } catch (err) {
    console.error("Failed to index message for search:", err);
  }
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export async function hybridSearch(
  query: string,
  topK: number = 10,
): Promise<SearchResult[]> {
  // FTS5 keyword search (always available)
  let ftsResults: FTSHit[] = [];
  try {
    const sanitized = query
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => `"${word.replace(/"/g, '""')}"`)
      .join(" ");
    if (sanitized) {
      ftsResults = searchFTS(sanitized, topK * 2);
    }
  } catch (err) {
    console.error("FTS search failed:", err);
  }

  // Semantic search (requires OpenAI API key + sqlite-vec)
  let semanticResults: SearchHit[] = [];
  if (vecLoaded && process.env.OPENAI_API_KEY) {
    try {
      await backfillSearchEmbeddings();

      const queryEmbedding = await embedText(query);
      semanticResults = searchEmbeddings(
        new Float32Array(queryEmbedding),
        topK * 2,
      );
    } catch (err) {
      console.error("Semantic search failed:", err);
    }
  }

  if (ftsResults.length === 0 && semanticResults.length === 0) {
    return [];
  }

  // FTS-only fallback when no embeddings available
  if (semanticResults.length === 0) {
    return ftsResults.slice(0, topK).map((hit) => ({
      messageId: hit.id,
      conversationId: hit.conversation_id,
      role: hit.role,
      contentPreview: hit.content,
      score: -hit.rank,
      matchType: "keyword" as const,
    }));
  }

  return reciprocalRankFusion(semanticResults, ftsResults, topK);
}
