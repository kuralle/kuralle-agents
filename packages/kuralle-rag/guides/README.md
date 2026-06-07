# Kuralle RAG Guides

Docs for `@kuralle-agents/rag` -- the RAG primitives and vector search layer for Kuralle.

## Getting Started

- **[Getting Started](./GETTING_STARTED.md)** -- Install, ingest documents, retrieve, wire to an agent

## Reference

- **[KnowledgeFs](./KNOWLEDGEFS.md)** -- Read-only `FileSystem` over a vector store (grep+cat support agent)
- **[Primitives](./PRIMITIVES.md)** -- All interfaces and implementations: Embedder, VectorStore, Retriever, Reranker, Chunker, RagPipeline, and the legacy KnowledgeSource/KnowledgeRetriever APIs
- **[Vector Retrieval Tool](./VECTOR_RETRIEVAL_TOOL.md)** -- `createVectorRetrievalTool` with agentic filters, static filters, and agent integration
