# OpenGrove

Local-first AI chat app with conversation branching, RAG-powered long-term memory, and multi-provider support.

## Quick Start

```bash
cd app && npm install && npm run dev
```

Requires API keys: set `GEMINI_API_KEY` and/or `OPENAI_API_KEY` in a `.env` file at the repo root, or add them via the Settings page at runtime.

## Tech Stack

- **Framework**: Next.js 14 (App Router), React 18, TypeScript 5.6
- **Database**: SQLite via `better-sqlite3`, `sqlite-vec` for vector search
- **Styling**: Tailwind CSS, Radix UI primitives
- **AI providers**: `@google/genai` (Gemini), `openai` (OpenAI + embeddings), local OpenAI-compatible endpoints
- **Other**: `compromise` (NLP for PII name detection), `react-markdown` + `remark-gfm` + `rehype-highlight`

## Project Structure

```
app/src/
├── app/
│   ├── page.tsx                    # Main chat UI — all top-level state lives here
│   ├── layout.tsx                  # Root layout (dark theme, metadata)
│   ├── globals.css                 # Tailwind base + CSS variables
│   ├── settings/page.tsx           # Settings UI (API keys, model toggles, PII toggle)
│   └── api/
│       ├── chat/route.ts           # POST — streaming chat (provider routing, RAG, PII)
│       ├── conversations/route.ts  # GET — list conversations
│       ├── conversations/[id]/
│       │   ├── route.ts            # GET conversation+messages, DELETE with cascade
│       │   ├── branch/route.ts     # POST — create branch at message index
│       │   └── cost/route.ts       # GET — aggregated token usage and cost
│       ├── settings/route.ts       # GET/POST — settings CRUD
│       ├── settings/test/route.ts  # POST — test API key connectivity
│       └── local-models/route.ts   # GET — list models from local endpoint
├── components/
│   ├── ChatInput.tsx               # Input textarea + model selector dropdown + reply preview
│   ├── MessageList.tsx             # Message rendering (markdown, branch/reply/copy buttons, quote blocks)
│   ├── Sidebar.tsx                 # Conversation tree with branch nesting
│   ├── ConfirmModal.tsx            # Confirmation dialog for destructive actions
│   └── ui/                         # Radix UI wrapper components (button, input, tooltip, etc.)
├── lib/
│   ├── db.ts                       # Database: schema, migrations, all CRUD operations
│   ├── model-constants.ts          # Model IDs, pricing, calculateCost()
│   ├── tokens.ts                   # estimateTokens(), buildMessageWindow()
│   ├── rag.ts                      # RAG orchestration: budget split, retrieval, context building
│   ├── embeddings.ts               # OpenAI embeddings, chunking, embedAndStoreOverflow()
│   ├── pii.ts                      # PII detection & redaction (regex + compromise NLP)
│   └── utils.ts                    # cn() for Tailwind class merging
└── types/index.ts                  # Shared types: Conversation, Message, ClientMessage, LineageEntry
```

The SQLite database file lives at the repo root: `opengrove.db`. It auto-initializes on first run.

## Architecture

### Client/Server Split

- **Client components** (`"use client"`): `page.tsx`, all components in `components/`, `settings/page.tsx`
- **Server**: API routes in `app/api/`
- No external state manager — all state is React `useState`/`useCallback` in `page.tsx`, synced via fetch to API routes

### Path Alias

`@/*` maps to `./src/*` (configured in `tsconfig.json`).

### Environment Variables

`next.config.js` loads `.env` from the repo root (one level above `app/`). Keys can also be set via the Settings page (stored in the DB `settings` table, which takes priority over `.env`).

## Database

### Schema

Six tables. The core three:

- **conversations** — `id`, `title`, `model`, `created_at`, `parent_id` (branching), `branch_point_index`
- **messages** — `id`, `conversation_id` (FK cascade), `role`, `content`, `created_at`, `is_embedded`, `reply_to_id`
- **settings** — `key` (PK), `value`, `updated_at`

Supporting tables:

- **usage** — `id`, `conversation_id` (FK cascade), `message_id`, `model`, `input_tokens`, `output_tokens`, `cost`, `created_at`
- **embedding_config** — singleton row tracking active embedding model + dimensions
- **message_chunks** — `sqlite-vec` virtual table for vector search (partition key: `conversation_id`)

### Migration Pattern

Idempotent `ALTER TABLE` wrapped in try-catch:

```ts
try {
  db.exec("ALTER TABLE messages ADD COLUMN reply_to_id TEXT DEFAULT NULL");
} catch {
  // Column already exists — ignore
}
```

New columns always use this pattern. Never use destructive migrations.

### Settings System

Setting keys are defined in `SUPPORTED_SETTINGS_KEYS` (array in `db.ts`). To add a new setting:

1. Add the key string to `SUPPORTED_SETTINGS_KEYS`
2. Add a `?` placeholder to the `getSettings()` SQL query (count must match array length)
3. Read/write via `getSettings()` / `upsertSettings()`
4. Add UI control in `settings/page.tsx`

All settings are stored as strings. Booleans use `"true"`/`"false"`, parsed with `parseBooleanSetting()`. Arrays (like `hidden_models`) are stored as JSON strings.

## Streaming

The chat endpoint (`/api/chat`) returns a `ReadableStream` of NDJSON lines:

```
{"type":"chunk","text":"partial response..."}
{"type":"done","conversationId":"...","message":{...},"usage":{...}}
{"type":"error","error":"Something failed"}
```

The client reads with `res.body.getReader()`, splits on newlines, and parses each line. Chunk events update the streaming assistant message in real-time. The done event finalizes the message and triggers conversation list refresh.

## Provider Routing

Model routing in `chat/route.ts`:

| Condition | Provider | API |
|-----------|----------|-----|
| `modelKey` in `OPENAI_MODELS` or starts with `gpt-` | OpenAI | `openai.responses.create()` with `web_search_preview` |
| `modelKey` starts with `local:` | Local | OpenAI SDK with custom `baseURL` |
| Otherwise | Gemini | `ai.models.generateContentStream()` with `googleSearch` |

Settings (`getSettings()`) is called once per request and reused across all provider branches.

## Key Features

### Conversation Branching

Each conversation can have a `parent_id` and `branch_point_index`. `getFullHistory()` walks the lineage chain (child → parent → grandparent → root) and concatenates messages, slicing at each branch point. The Sidebar renders conversations as a tree.

### RAG (Long-Term Memory)

When the message window overflows (doesn't fit the model's context), overflow messages are embedded (via OpenAI `text-embedding-3-small`) and stored in `message_chunks`. On subsequent messages, the user's query is embedded and KNN-searched against stored chunks. Retrieved context is prepended to the history as a synthetic user/assistant exchange.

Budget split: 20% for RAG context, 80% for recent messages, minus 4096 tokens reserved for the response.

### Cost Tracking

`MODEL_PRICING` in `model-constants.ts` maps each model to per-token input/output costs. After each response, a `usage` row is inserted. Token counts come from provider responses (OpenAI: `response.completed` event, Gemini: `usageMetadata`, local: `chunk.usage`), falling back to `estimateTokens()` (~4 chars/token heuristic).

### Reply to Message

Messages can reference another message via `reply_to_id`. On the server, the quoted message content is prepended to the user's message in the LLM history as `[Replying to {role}: "..."]`. On the client, a `QuoteBlock` component renders the quoted message above the reply. The raw user text is stored without the prefix.

### PII Redaction

When `pii_redaction_enabled` is `"true"`, the entire `history` array is redacted before being sent to any cloud API. Skipped for local models. Redaction uses regex patterns (emails, phones, SSNs, credit cards, addresses) and `compromise` NLP (person names). Original messages in the DB are never modified.

## Conventions

### Naming

- Components: PascalCase default exports (`ChatInput.tsx`)
- DB functions: verb-first camelCase (`getConversation`, `insertMessage`, `createBranch`)
- Constants: UPPER_SNAKE_CASE (`MODEL_CONTEXT_TOKENS`, `RESPONSE_BUFFER_TOKENS`)
- Callbacks/props: `on` prefix (`onSelect`, `onBranch`, `onReply`)
- State: `[thing, setThing] = useState()`

### Adding a New Feature

Typical flow:

1. Types in `types/index.ts` if new data shapes are needed
2. DB migration + CRUD functions in `lib/db.ts`
3. API route in `app/api/`
4. Wire into `page.tsx` state and handlers
5. Component updates in `components/`
6. Type-check: `npx tsc --noEmit` from `app/`

### Error Handling

- API routes: try-catch returning `NextResponse.json({ error }, { status })`. Streaming errors send `{ type: "error" }` via NDJSON.
- Client: try-catch with `alert()` for user-facing errors.
- Fire-and-forget operations (embeddings): `.catch(err => console.error(...))`.
- RAG failures degrade gracefully — chat proceeds without context.

### Things to Avoid

- No external state managers — keep state in `page.tsx` with React hooks
- No destructive DB migrations — always use additive try-catch `ALTER TABLE`
- Don't modify stored message content for transient concerns (PII redaction modifies only the outbound `history` array, not DB records)
- `getSettings()` returns a `SettingsMap` with string values — parse booleans/JSON explicitly at call sites
