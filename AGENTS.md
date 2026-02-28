# OpenGrove — Agent Context Document

## 1. Project Overview

OpenGrove is a local-first AI chat application with conversation branching and RAG-based long-term memory. Users chat with multiple LLM providers (Gemini, OpenAI, local models), and the app automatically embeds older messages into a vector store so they can be retrieved when the conversation exceeds the context window.

**Tech stack:**
- **Runtime:** Next.js 14 (App Router), React 18, TypeScript 5.6
- **Database:** SQLite via `better-sqlite3`, vector search via `sqlite-vec` 0.1.7-alpha.2
- **LLM providers:** Google GenAI SDK (`@google/genai`), OpenAI SDK (`openai`), any OpenAI-compatible local endpoint
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **UI:** Tailwind CSS, Radix UI primitives, React Markdown with remark-gfm + rehype-highlight, Lucide icons

The database file (`opengrove.db`) lives at the repo root. All data is local — no remote sync, no auth.

## 2. Architecture

```
opengrove/
├── .env.example          # Environment template
├── opengrove.db          # SQLite database (created at runtime)
├── app/                  # Next.js application
│   ├── package.json
│   ├── next.config.js    # Loads .env from parent directory
│   └── src/
│       ├── app/
│       │   ├── layout.tsx           # Root layout, dark mode
│       │   ├── page.tsx             # Main chat UI (client component, all state here)
│       │   ├── globals.css          # CSS variables, prose-chat styles
│       │   ├── settings/page.tsx    # Settings page (API keys, models, local runtime)
│       │   └── api/                 # API routes (see section below)
│       ├── components/
│       │   ├── Sidebar.tsx          # Tree-structured conversation list
│       │   ├── MessageList.tsx      # Message rendering, branch/copy buttons, markdown
│       │   ├── ChatInput.tsx        # Textarea, model selector, send button
│       │   ├── ConfirmModal.tsx     # Confirmation dialog
│       │   └── ui/                  # Radix UI primitive wrappers (button, input, etc.)
│       ├── lib/
│       │   ├── db.ts               # All SQLite operations (544 lines, the core)
│       │   ├── rag.ts              # RAG orchestrator: budget split, retrieval, context building
│       │   ├── tokens.ts           # Token estimation, message windowing
│       │   ├── embeddings.ts       # OpenAI embedding calls, chunking, store overflow
│       │   ├── pii.ts              # PII redaction: redactPII() — regex + compromise NLP
│       │   ├── model-constants.ts  # Model IDs, MODEL_PRICING, calculateCost()
│       │   └── utils.ts            # cn() utility (clsx + tailwind-merge)
│       └── types/
│           └── index.ts            # Conversation, Message, ClientMessage, LineageEntry
```

**What lives where:**
- `lib/` — All server-side logic. `db.ts` is the data layer. `rag.ts`, `tokens.ts`, `embeddings.ts` form the RAG pipeline. `model-constants.ts` has pricing and cost calculation. `pii.ts` handles PII redaction. No client code imports from `lib/`.
- `components/` — React client components. `ui/` contains Radix primitive wrappers. Top-level components (`Sidebar`, `MessageList`, `ChatInput`) are the app's UI building blocks.
- `api/` — Next.js route handlers. Each route file exports `GET`, `POST`, or `DELETE` async functions. All routes use `export const dynamic = "force-dynamic"` to disable caching.
- `types/` — Shared TypeScript interfaces used by both client and server.

## 3. Database

SQLite with WAL mode implied by `better-sqlite3`. The schema is defined inline in `db.ts` with `CREATE TABLE IF NOT EXISTS` and migration-style `ALTER TABLE` wrapped in try-catch for idempotency.

### Core Tables

**conversations**
```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,                          -- UUID
  title TEXT NOT NULL DEFAULT 'New chat',
  model TEXT NOT NULL DEFAULT 'gemini-2.0-flash',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  parent_id TEXT DEFAULT NULL,                  -- NULL for root, FK for branches
  branch_point_index INTEGER DEFAULT NULL       -- message index where branch diverges
);
```

**messages**
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,                          -- UUID
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  is_embedded INTEGER NOT NULL DEFAULT 0,       -- 1 = already chunked and stored in vector table
  reply_to_id TEXT DEFAULT NULL,                -- FK to another message (added in T2)
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
```

**settings**
```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,      -- Validated against SUPPORTED_SETTINGS_KEYS whitelist
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```
Supported keys: `openai_api_key`, `gemini_api_key`, `anthropic_api_key`, `default_model`, `hidden_models`, `local_models_enabled`, `local_runtime`, `local_endpoint`, `local_models_hidden`, `pii_redaction_enabled`.

**usage** (cost tracking — one row per assistant response)
```sql
CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX idx_usage_conversation ON usage(conversation_id);
```

**embedding_config** (singleton)
```sql
CREATE TABLE embedding_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- Enforced single row
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### Vector Table (sqlite-vec)

```sql
CREATE VIRTUAL TABLE message_chunks USING vec0(
  chunk_id text primary key,
  conversation_id text partition key,
  +chunk_text text,
  +start_msg_index integer,
  +end_msg_index integer,
  +embedding_model text,
  +created_at integer,
  embedding float[1536]
);
```

Key details:
- `conversation_id` is a **partition key** — sqlite-vec requires querying one partition at a time, so `queryChunks` loops over each conversation ID separately and merges results.
- `+column` syntax stores auxiliary data alongside vectors.
- Embeddings are stored as `Buffer.from(float32Array.buffer)`.
- KNN query syntax: `WHERE embedding MATCH ? AND conversation_id = ? AND k = ?`.

### Schema Migrations

Columns added after initial schema (`parent_id`, `branch_point_index`, `is_embedded`, `reply_to_id`) use try-catch `ALTER TABLE` — if the column already exists, the error is silently caught. This is the project's migration pattern. Follow it for any new columns.

## 4. RAG Pipeline

Defined in `lib/rag.ts`. The entry point is `buildContextWithRAG()`.

### Flow

1. **Budget split:** Available tokens = `contextLimit - responseBuffer(4096)`. RAG gets 20% (`RAG_BUDGET_RATIO = 0.2`), recent messages get 80%.
2. **Window recent messages:** `buildMessageWindow()` fills the 80% budget with the most recent messages (see Token Windowing below). Messages that don't fit become `overflow`.
3. **Skip conditions:** RAG is skipped if: sqlite-vec not loaded, `OPENAI_API_KEY` missing, no overflow messages, or query is < 10 tokens.
4. **Retrieve chunks:** Embed the user query, resolve conversation lineage, run KNN against each ancestor's partition, filter by `maxMsgIndex` for branch-safety, sort by distance, take top-k (default 5) within token budget.
5. **Return:** `{ ragContext: string | null, recentMessages: Message[], overflow: Message[] }`.

### Context Injection

The chat route (`api/chat/route.ts`) prepends RAG context as a synthetic user/assistant pair at the start of the message history:

```ts
{ role: "user", content: "Relevant context from earlier in this conversation:\n" + ragContext }
{ role: "assistant", content: "Understood, I have that context." }
```

### Overflow Embedding (async)

After the assistant response is streamed, `embedAndStoreOverflow()` is called **fire-and-forget** (`.catch()` swallows errors). It:
1. Filters to unembedded messages only (checks `is_embedded` flag)
2. Chunks messages in groups of 4, formatted as `"USER: ...\nASSISTANT: ..."`
3. Batch-embeds all chunks in a single OpenAI API call
4. Stores each chunk with its `start_msg_index` / `end_msg_index`
5. Marks source messages as `is_embedded = 1`

### Graceful Degradation

If anything in the RAG path fails (sqlite-vec missing, API key missing, embedding call fails), the system logs the error and proceeds without RAG context. Chat never breaks because of RAG.

## 5. Token Windowing

Defined in `lib/tokens.ts`.

**Token estimation:** `Math.ceil(text.length / 4)` — rough approximation, intentionally imprecise. The 4096-token response buffer absorbs estimation error.

**`buildMessageWindow(messages, tokenBudget)`:**
1. Walk backwards from the most recent message.
2. If the current message is an `assistant` message and the previous is `user`, treat them as a **pair**. Compute combined cost. If the pair fits, include both. If not, stop.
3. Solo messages (consecutive same-role, or edge cases) are handled individually.
4. **Critical invariant: user/assistant pairs are never split.** If a pair doesn't fit, both are excluded.
5. Everything from index 0 through the cutoff point becomes `overflow` (fed to the embedding pipeline).
6. Return `{ window, overflow }` — window is in chronological order.

## 6. Embedding System

Defined in `lib/embeddings.ts`.

- **Model:** `text-embedding-3-small`, 1536 dimensions (constants exported as `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`)
- **API:** OpenAI embeddings API via the `openai` SDK. `embedTexts()` batches multiple texts in one call. `embedText()` is a single-text convenience wrapper.

### Config Lifecycle (`ensureEmbeddingConfig`)

Called once per process (guarded by `configChecked` flag). Handles three cases:
1. **First run:** Creates the `embedding_config` row and the `message_chunks` virtual table.
2. **Model changed:** Wipes all vectors (`resetAllEmbeddings` — sets `is_embedded = 0` on all messages, drops and recreates the virtual table), updates config.
3. **Same model:** Ensures the virtual table exists (idempotent no-op).

If you change the embedding model or dimensions, update the constants in `embeddings.ts`. The system auto-detects the mismatch on next startup and re-embeds everything.

### Chunking

`chunkMessages(messages, chunkSize=4)` groups messages into chunks of 4, serialized as:
```
USER: message content
ASSISTANT: response content
USER: next message
ASSISTANT: next response
```
Each chunk tracks `messageIds`, `startIndex`, and `endIndex` for later reference.

## 7. Branch-Aware Lineage

Conversations form a **tree**. Root conversations have `parent_id = NULL`. Branches store `parent_id` (which conversation they forked from) and `branch_point_index` (which message index in the parent's history the fork happened at).

### Key Operations

**`createBranch(parentId, branchPointIndex)`:** Creates a new conversation row with `parent_id` and `branch_point_index`. No messages are copied — the branch *references* its parent's messages up to the branch point via the lineage chain. Only new messages after the branch point live in the branch's own `messages` rows.

**`getConversationLineage(conversationId)`:** Walks up the `parent_id` chain. Returns `[self, parent, grandparent, ..., root]`. Each entry has `{ conversationId, branchPointIndex }`. Uses a `visited` set to prevent infinite loops.

**`getFullHistory(conversationId)`:** Reconstructs the complete message history by walking the lineage bottom-up (root first). For each ancestor, takes messages up to the next descendant's `branchPointIndex + 1`. For the conversation itself, takes all its own messages. Concatenates all segments.

**`deleteConversationTree(id)`:** BFS collects all descendants, deletes vector chunks for each, then batch-deletes all conversations. Message deletion cascades via FK.

### Branch-Aware RAG

When retrieving chunks for a branched conversation, the lineage is resolved and each ancestor is queried separately. For ancestor conversations, results are filtered to `start_msg_index <= branchPointIndex` to prevent cross-branch contamination.

## 8. Environment Setup

**`.env` location:** The app looks for `.env` at the **repo root** (one level above `app/`). This is configured in `next.config.js`:
```js
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
```
Copy `.env.example` to `.env` and fill in API keys.

**Required keys:**
- `GEMINI_API_KEY` — For Gemini models (also configurable via Settings UI → stored in `settings` table)
- `OPENAI_API_KEY` — For OpenAI models AND for embeddings (RAG requires this)

**Database path:** `path.join(process.cwd(), "..", "opengrove.db")` — assumes the Next.js dev server runs from `app/`. The DB is created automatically on first run.

**Running the app:**
```bash
cd app
npm install
npm run dev
```

## 9. Conventions

### Nullable Columns for Backward Compatibility

New columns are added via `ALTER TABLE ... ADD COLUMN ... DEFAULT NULL` wrapped in try-catch. This means:
- New columns must be nullable or have a default value.
- Existing rows get the default automatically.
- The try-catch swallows "column already exists" errors, making the migration idempotent.
- Follow this exact pattern for any schema additions.

### File Naming

- Database columns: `snake_case` (`conversation_id`, `branch_point_index`, `is_embedded`)
- TypeScript: `camelCase` (`conversationId`, `branchPointIndex`, `isEmbedded`)
- Constants: `UPPER_SNAKE_CASE` (`EMBEDDING_MODEL`, `RAG_BUDGET_RATIO`, `RESPONSE_BUFFER_TOKENS`)
- Components: `PascalCase` filenames (`Sidebar.tsx`, `MessageList.tsx`)
- Lib modules: `kebab-case` filenames (`model-constants.ts`)

### API Route Patterns

- One file per route: `app/api/[path]/route.ts`
- Export named async functions: `GET`, `POST`, `DELETE`
- Dynamic params use Next.js 15 pattern: `{ params }: { params: Promise<{ id: string }> }` — must `await params`
- All list/read routes use `export const dynamic = "force-dynamic"` to prevent caching
- Success responses: `NextResponse.json(data)` or `NextResponse.json(data, { status: 201 })`
- Error responses: `NextResponse.json({ error: "message" }, { status: 4xx/5xx })`
- Chat streaming: Returns a `Response` with `ReadableStream`, content type `application/x-ndjson`

### Streaming Protocol (Chat)

The chat endpoint returns newline-delimited JSON (NDJSON):
```json
{"type": "chunk", "text": "partial response..."}
{"type": "chunk", "text": "more text..."}
{"type": "done", "conversationId": "uuid", "message": {"role": "assistant", "content": "full text", "id": "uuid"}, "usage": {"inputTokens": 150, "outputTokens": 42, "cost": 0.000123}}
```
On error during streaming:
```json
{"type": "error", "error": "description"}
```

### Error Handling

- API routes: try-catch at the top level, return JSON error with status code.
- Embeddings: fire-and-forget with `console.error`. Never throws into the chat flow.
- RAG: catches errors and returns `ragContext: null`. Chat continues without RAG.
- sqlite-vec operations: guarded by `vecLoaded` boolean. All vector functions are no-ops when vec isn't loaded.

### DB Function Signatures

All `db.ts` functions are `async` even though `better-sqlite3` is synchronous. This is a consistency convention — it lets them be used with `await` uniformly and makes future migration to async drivers easier.

### Settings Architecture

API keys can come from two places (checked in order):
1. The `settings` table (set via the Settings UI)
2. Environment variables (`.env` file)

The chat route checks both: `settings.openai_api_key?.trim() || process.env.OPENAI_API_KEY`.

## 10. Cost Tracking

Defined across `lib/model-constants.ts`, `lib/db.ts`, and `api/chat/route.ts`.

### Pricing Config

`MODEL_PRICING` in `lib/model-constants.ts` maps model ID strings to `{ input: number; output: number }` per-token costs in USD. Prices are expressed as `X / 1e6` (per-million-token rate divided inline). Every supported cloud model has an entry. Local and unknown models return cost 0.

```ts
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o":        { input: 2.50  / 1e6, output: 10.00 / 1e6 },
  "gemini-2.0-flash": { input: 0.10 / 1e6, output: 0.40 / 1e6 },
  // ...
};
```

### Cost Calculation

`calculateCost(model, inputTokens, outputTokens)` in `lib/model-constants.ts`. Looks up `MODEL_PRICING[model]`, returns `inputTokens * pricing.input + outputTokens * pricing.output`. Returns 0 if the model isn't in the pricing table.

### Token Counting

Token counts come from the provider response:
- **OpenAI:** `event.response.usage.input_tokens` / `output_tokens` from the `response.completed` event
- **Gemini:** `chunk.usageMetadata.promptTokenCount` / `candidatesTokenCount`
- **Local:** `chunk.usage.prompt_tokens` / `completion_tokens`

**Fallback:** If both counts are 0 after streaming completes, `estimateTokens()` (~4 chars/token) is used.

### Storage

After each assistant response in `api/chat/route.ts`:
```ts
const cost = calculateCost(modelKey, inputTokens, outputTokens);
await insertUsage(randomUUID(), id, assistantMsgId, modelKey, inputTokens, outputTokens, cost);
```

`insertUsage()` writes a row to the `usage` table. `getConversationCost(conversationId)` aggregates with `SUM()` and returns `{ totalCost, totalInputTokens, totalOutputTokens }` (type `ConversationCost`).

### API Endpoint

`GET /api/conversations/[id]/cost` — returns `ConversationCost` JSON. Used by `page.tsx` on conversation load.

### Client Display

`page.tsx` state: `conversationCost` (number). Loaded from the cost endpoint via `fetchCost(id)` when switching conversations. Incrementally updated from the `done` stream event's `usage.cost` field. Displayed in the header as a monospace dollar amount — `toFixed(6)` if < $0.01, `toFixed(4)` otherwise.

### Integration Rule

**Any new code that makes LLM or embedding API calls must call `calculateCost()` and `insertUsage()` to record the usage.** If adding a new model, add its pricing to `MODEL_PRICING`.

## 11. Message Reply System

Defined across `lib/db.ts`, `types/index.ts`, `api/chat/route.ts`, `components/MessageList.tsx`, `components/ChatInput.tsx`, and `page.tsx`.

### Schema

The `messages` table has a `reply_to_id TEXT DEFAULT NULL` column (added via idempotent `ALTER TABLE` migration). It holds the UUID of the message being replied to.

Types in `types/index.ts`:
```ts
type Message = { ..., reply_to_id?: string | null };      // DB-level (snake_case)
type ClientMessage = { ..., replyToId?: string | null };   // Client-level (camelCase)
```

### DB Helpers

- `getMessage(id)` — returns a single `Message` by UUID. Used to look up the quoted message for reply context.
- `insertMessage(id, conversationId, role, content, replyToId?)` — accepts optional `replyToId`, stores as `reply_to_id`.

### API Injection

In `api/chat/route.ts`, after inserting the user message:
1. If `replyToId` is present, look up the quoted message via `getMessage(replyToId)`.
2. Build `replyContext` string: `[Replying to {role}: "{truncated content (300 chars)}"]`
3. Prepend it to the last user message in the `history` array before sending to the provider.
4. The raw user text is stored in the DB without this prefix — only the LLM sees it.

```ts
let replyContext: string | null = null;
if (replyToId) {
  const quotedMsg = await getMessage(replyToId);
  if (quotedMsg) {
    const truncated = quotedMsg.content.length > 300
      ? quotedMsg.content.slice(0, 300) + "..." : quotedMsg.content;
    replyContext = `[Replying to ${quotedMsg.role}: "${truncated}"]`;
  }
}
// Later, prepend to last user message in history:
if (replyContext && history.length > 0) {
  const last = history[history.length - 1];
  if (last.role === "user") {
    last.content = replyContext + "\n\n" + last.content;
  }
}
```

### Client State

`page.tsx`: `replyTo` state (`ClientMessage | null`). Set by `onReply` callback from MessageList, cleared on send and on new chat. The `replyToId` is included in the POST body to `/api/chat`.

### UI Components

**QuoteBlock** (in `components/MessageList.tsx`): Renders a compact left-bordered quote (120-char truncation) above any message that has `replyToId`. Uses `messageMap` (`Map<string, ClientMessage>`, built via `useMemo` over the messages array) for O(1) lookup.

**Reply preview bar** (in `components/ChatInput.tsx`): When `replyTo` is set, shows a dismissable bar above the input with "Replying to {role}" label, truncated content (100 chars), and an X button (`onCancelReply`). Auto-focuses the textarea when entering reply mode.

**Reply button**: Each message has a "↩ Reply" button in its hover actions (alongside Branch and Copy).

### Integration Rule

**To reference messages (within or across conversations), use `getMessage()` from `lib/db.ts` for lookup, `reply_to_id` / `replyToId` for storage, `QuoteBlock` for display, and the `[Replying to ...]` prefix for LLM context injection.** Don't build a parallel reference system.

## 12. PII Guardrail

Defined in `lib/pii.ts` with integration in `api/chat/route.ts` and `settings/page.tsx`.

### How Redaction Works

`redactPII(text: string): string` in `lib/pii.ts`. Two-phase detection:

1. **Regex patterns** (run first): SSNs → `[SSN]`, credit cards → `[CREDIT_CARD]`, emails → `[EMAIL]`, US phone numbers → `[PHONE]`, US street addresses → `[ADDRESS]`.
2. **NLP names** (run second, on already-regex-redacted text): Uses `compromise` library's `.people()` extraction. Deduplicates names, sorts longest-first, replaces with `[NAME]` using word-boundary regex.

Regex runs first so `compromise` doesn't try to parse already-redacted placeholders. Everything runs locally — no network calls.

### Pipeline Position

In `api/chat/route.ts`, PII redaction happens **after** the full `history` array is assembled (including RAG context preamble and reply context injection) but **before** the history is sent to any provider:

```
build history → inject RAG context → inject reply context → PII redaction → send to provider
```

```ts
if (settings.pii_redaction_enabled === "true" && !isLocalModel(modelKey)) {
  for (const entry of history) {
    entry.content = redactPII(entry.content);
  }
}
```

This means:
- RAG context is redacted (good — it may contain PII from old messages).
- Reply context prefix is redacted.
- Original messages in the DB are **never modified**. Only the outbound `history` array is scrubbed.
- Local models are exempt (data stays on-machine anyway).

### Settings Toggle

Setting key: `pii_redaction_enabled` (in `SUPPORTED_SETTINGS_KEYS`). Stored as `"true"` / `"false"` string. Toggle UI on `settings/page.tsx` General tab — same switch pattern as `local_models_enabled`.

### Dependency

`compromise` (v14, ~200KB) — NLP library for person name detection. Added to `app/package.json`. No other external dependencies.

### Integration Rule

**Any new code path that sends user content to a cloud LLM must check `settings.pii_redaction_enabled` and call `redactPII()` on the content before sending. Skip for local models (`isLocalModel(modelKey)`).**

```ts
import { redactPII } from "@/lib/pii";
// After building history, before sending:
if (settings.pii_redaction_enabled === "true" && !isLocalModel(modelKey)) {
  for (const entry of history) {
    entry.content = redactPII(entry.content);
  }
}
```

## 13. Key Gotchas

1. **DB path is relative.** `process.cwd()` must be `app/` for the path `../opengrove.db` to resolve correctly. If you change how the app is started, the DB path will break.

2. **sqlite-vec can fail to load.** If the native extension doesn't compile or isn't available, `vecLoaded` is `false` and all RAG features silently disable. Check the console for the warning message.

3. **Embeddings require OPENAI_API_KEY regardless of chat provider.** Even if you only use Gemini for chat, RAG embedding always uses OpenAI's embedding API. No OpenAI key = no RAG.

4. **The `embedding_config` table is a singleton.** The `CHECK (id = 1)` constraint enforces exactly one row. Use `upsertEmbeddingConfig`, not raw INSERT.

5. **Partition key queries.** sqlite-vec requires querying one `conversation_id` at a time. `queryChunks` handles this by looping, but if you write new vector queries, you must do the same — you cannot query across partitions in a single statement.

6. **Branch messages are not copied.** When a branch is created, no messages are duplicated. The branch references parent messages via lineage. This means deleting a parent conversation deletes the shared history for all its branches (cascade delete handles this).

7. **`getFullHistory` is the only correct way to get a conversation's messages.** Don't use `getMessages` alone for branched conversations — it only returns messages owned directly by that conversation, not inherited ancestor messages.

8. **User/assistant pair invariant.** The windowing algorithm assumes messages alternate user/assistant. If you insert messages that break this pattern (e.g., consecutive user messages), the windowing still works but may include unpaired messages as singletons.

9. **`hidden_models` is stored as JSON string.** The settings table stores it as a serialized JSON array. The settings API route parses/serializes it. Don't store raw arrays in the settings table.

10. **`params` is a Promise.** Next.js dynamic route params must be awaited: `const { id } = await params`. This is the Next.js 15 convention used throughout the codebase. Forgetting to await will cause runtime errors.

11. **Model context sizes are hardcoded.** `MODEL_CONTEXT_TOKENS` in `api/chat/route.ts` maps model IDs to context window sizes. If you add a new model, add its context size here or it defaults to 32,768 tokens.

12. **Fire-and-forget embedding.** `embedAndStoreOverflow` runs after the response is streamed. If the process dies mid-embedding, those messages stay `is_embedded = 0` and will be picked up next time there's overflow containing them.
