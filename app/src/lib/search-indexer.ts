import type { Message } from "@/types";
import {
  vecLoaded,
  insertSearchEmbedding,
  markMessagesSearchIndexed,
  getUnindexedMessages,
} from "@/lib/db";
import {
  embedTexts,
  ensureEmbeddingConfig,
  EMBEDDING_MODEL,
} from "@/lib/embeddings";

const CONTENT_PREVIEW_LENGTH = 200;
const BATCH_SIZE = 50;

function truncateContent(content: string): string {
  if (content.length <= CONTENT_PREVIEW_LENGTH) return content;
  return content.slice(0, CONTENT_PREVIEW_LENGTH) + "...";
}

/**
 * Index a single message for global search.
 * Designed to be called fire-and-forget (errors are logged, not thrown).
 */
export async function indexMessageForSearch(message: Message): Promise<void> {
  if (!vecLoaded) return;

  try {
    await ensureEmbeddingConfig();

    const text = `${message.role.toUpperCase()}: ${message.content}`;
    const [embedding] = await embedTexts([text]);
    const embeddingVec = new Float32Array(embedding);

    insertSearchEmbedding(
      message.id,
      message.conversation_id,
      message.role,
      truncateContent(message.content),
      EMBEDDING_MODEL,
      embeddingVec,
    );

    markMessagesSearchIndexed([message.id]);
  } catch (err) {
    console.error("Failed to index message for search:", err);
  }
}

/**
 * Index multiple messages in batch for global search.
 */
export async function indexMessagesForSearch(
  messages: Message[],
): Promise<{ indexed: number; failed: number }> {
  if (!vecLoaded || messages.length === 0) return { indexed: 0, failed: 0 };

  await ensureEmbeddingConfig();

  let indexed = 0;
  let failed = 0;

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const texts = batch.map((m) => `${m.role.toUpperCase()}: ${m.content}`);

    try {
      const embeddings = await embedTexts(texts);

      for (let j = 0; j < batch.length; j++) {
        const msg = batch[j];
        const embeddingVec = new Float32Array(embeddings[j]);

        insertSearchEmbedding(
          msg.id,
          msg.conversation_id,
          msg.role,
          truncateContent(msg.content),
          EMBEDDING_MODEL,
          embeddingVec,
        );
      }

      markMessagesSearchIndexed(batch.map((m) => m.id));
      indexed += batch.length;
    } catch (err) {
      console.error(`Failed to index batch starting at ${i}:`, err);
      failed += batch.length;
    }
  }

  return { indexed, failed };
}

/**
 * Bulk backfill: find all unindexed messages and embed them.
 * Processes `limit` messages at a time.
 */
export async function backfillSearchIndex(
  limit: number = 100,
): Promise<{ indexed: number; failed: number; remaining: number }> {
  if (!vecLoaded) return { indexed: 0, failed: 0, remaining: 0 };

  const unindexed = getUnindexedMessages(limit);
  if (unindexed.length === 0) return { indexed: 0, failed: 0, remaining: 0 };

  const result = await indexMessagesForSearch(unindexed);

  const moreUnindexed = getUnindexedMessages(1);
  const remaining = moreUnindexed.length > 0 ? -1 : 0;

  return { ...result, remaining };
}
