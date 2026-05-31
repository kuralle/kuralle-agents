# RAG Demo -- Vector Search Support Agent

Acme Corp support agent with vector RAG retrieval. Demonstrates the full vector path: `Document -> Chunker -> Embedder -> VectorStore -> VectorRetriever -> createVectorRetrievalTool -> Agent -> Runtime -> Hono`.

## What It Shows

- Ingesting markdown documents into a vector store (chunk, embed, upsert)
- Retrieval via cosine similarity with `RagPipeline`
- Agentic metadata filters (LLM constructs filters at query time)
- Swappable vector stores: InMemory, PostgreSQL (pgvector), Redis (Redis Search)
- Session persistence across turns
- Hono server with SSE and WebSocket endpoints

## Setup

```bash
bun install
```

Copy `.env.example` to `.env` and add your OpenAI API key.

## Run

```bash
# In-memory (default, no external deps)
bun run dev          # HTTP server on :3334
bun run cli          # Interactive CLI

# PostgreSQL + pgvector
DATABASE_URL=postgresql://localhost:5432/kuralle_rag bun run dev:pg

# Redis + Redis Search
REDIS_URL=redis://localhost:6379 bun run dev:redis
```

## Vector Store Setup

### PostgreSQL

```bash
createdb kuralle_rag
psql -d kuralle_rag -c "CREATE EXTENSION IF NOT EXISTS vector"
```

### Redis

Requires Redis Stack (includes Redis Search module):

```bash
brew install redis-stack-server
redis-stack-server --daemonize yes
```

## File Structure

```
rag-demo/
  rag.ts        -- Pipeline setup: Embedder + VectorStore + Chunker + RagPipeline
  agent.ts      -- Agent with createVectorRetrievalTool (agentic filters enabled)
  server.ts     -- Hono server (SSE, WebSocket, health)
  cli.ts        -- Interactive CLI with inline search/result display
  knowledge/
    policies.md -- Refund, shipping, privacy, warranty, billing policies
    products.md -- Plans (Starter/Pro/Enterprise), Widget X100, Cloud Backup
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/api/chat/sse` | POST | SSE streaming |
| `/api/chat/stream` | POST | Plain text streaming |
| `/api/chat` | POST | Full response |
| `/ws/:sessionId` | WS | WebSocket streaming |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | OpenAI API key |
| `VECTOR_STORE` | No | `memory` | `memory`, `pg`, or `redis` |
| `DATABASE_URL` | When `pg` | -- | PostgreSQL connection string |
| `REDIS_URL` | When `redis` | `redis://localhost:6379` | Redis connection URL |
| `PORT` | No | `3334` | Server port |
