# CAG Demo -- LLM-Powered Restaurant Assistant

Bella's Italian Kitchen assistant using CAG (Cache-Augmented Generation). Demonstrates the CAG path: `KnowledgeSource -> Chunker -> KnowledgeRetriever (LLM) -> createCagTool -> Agent -> Runtime -> Hono`.

## What It Shows

- Static knowledge source from a markdown menu
- LLM-based retrieval: the LLM reads all chunks and ranks by relevance
- No embeddings, no vector database -- the LLM is the retriever
- Precise answers with prices, allergens, dietary info
- Works well for small, curated knowledge bases (context-window bound)

## CAG vs Vector RAG

| | CAG (this demo) | Vector RAG (rag-demo) |
|--|--|--|
| Retrieval | LLM reads all chunks, ranks them | Embedding similarity search |
| Storage | In-memory chunks | Vector database |
| Scaling | Context window bound (~50 chunks) | Millions of chunks |
| Precision | High (LLM understands synonyms) | Depends on embedding quality |
| Cost | Higher (LLM call per search) | Lower (embedding lookup) |

## Setup

```bash
bun install
```

Copy `.env.example` to `.env` and add your OpenAI API key.

## Run

```bash
bun run dev          # HTTP server on :3335
bun run cli          # Interactive CLI
```

## File Structure

```
cag-demo/
  agent.ts      -- Agent with createStaticKnowledgeSource + createLLMRetriever + createCagTool
  server.ts     -- Hono server (SSE, WebSocket, health)
  cli.ts        -- Interactive CLI with inline chunk ranking display
  knowledge/
    menu.md     -- Full restaurant menu with prices, allergens, dietary info
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
| `PORT` | No | `3335` | Server port |
