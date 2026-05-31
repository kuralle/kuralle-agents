# Acme Corp Support Agent

Customer support agent demonstrating three-layer knowledge retrieval — compiled knowledge, semantic cache, and hybrid retrieval with quality checks.

## Pipeline

```
Layer 1: Compiled Knowledge (0ms)     → system prompt injection
Layer 2: Semantic Cache (~0.4ms)      → RETRIEVAL_QUERY embeddings, dual-index
Layer 3: MultiHop → Fusion → Rerank   → decompose, BM25+vector, Cohere cross-encoder
         → Quality Check              → CRAG three-bucket, auto-reformulation
```

## Setup

```bash
# Required
export GOOGLE_GENERATIVE_AI_API_KEY=...

# Optional (enables Cohere reranking)
export COHERE_API_KEY=...

# Ingest knowledge base
bun run ingest

# Interactive CLI
bun run cli

# HTTP server (SSE/WS)
bun run dev
```

## Try These Queries

- **Multi-hop**: "Can I return the Widget X100, and if so, how long will the refund take?"
- **Multi-hop**: "Does the Pro Plan include cloud backup, and how much does it cost?"
- **Single-hop**: "What is the shipping policy?"
- **Cache test**: Ask the same question twice — second should be a cache hit
- **Off-topic**: "How do I train a neural network?" — should trigger quality check

## Features Demonstrated

| Feature | File | What It Does |
|---------|------|-------------|
| Task-type embeddings | `knowledge.ts` | `RETRIEVAL_DOCUMENT` for ingestion, `RETRIEVAL_QUERY` for search |
| MultiHopRetriever | `knowledge.ts` | Gemini Flash decomposes queries into sub-queries |
| RetrievalQualityChecker | `knowledge.ts` | CRAG three-bucket with Gemini Flash reformulation |
| KnowledgeProvider | `cli.ts` | `Runtime({ knowledge: ... })` wires everything |
| Observability events | `cli.ts` | `knowledge-quality-check`, `knowledge-reformulation` logged |
| Compiled knowledge | `scripts/ingest.ts` | Key facts in system prompt (0ms) |
| Semantic cache | `knowledge.ts` | Dual-index (query+document), LRU+TTL |
| Triage routing | `agents.ts` | Support vs Billing specialist routing |
