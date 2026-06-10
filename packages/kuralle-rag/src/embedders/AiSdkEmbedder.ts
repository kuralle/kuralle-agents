import { embed, embedMany } from 'ai';
import type { EmbeddingModel } from 'ai';
import type { Embedder } from '../types.js';

/** Infer the providerOptions type from the AI SDK embed() function. */
type EmbedParams = Parameters<typeof embed>[0];
type EmbedProviderOptions = NonNullable<EmbedParams['providerOptions']>;

export interface AiSdkEmbedderOptions {
  /** Any Vercel AI SDK embedding model. */
  model: EmbeddingModel;
  /**
   * Provider-specific options passed through to the AI SDK `embed()` /
   * `embedMany()` calls. Use this to set task types, dimensionality
   * overrides, or any other provider-specific parameter.
   *
   * Example (Gemini task type for query embedding):
   * ```ts
   * { google: { taskType: 'RETRIEVAL_QUERY' } }
   * ```
   */
  providerOptions?: EmbedProviderOptions;
}

/**
 * Embedder implementation backed by the Vercel AI SDK.
 *
 * Supports any provider registered with the AI SDK:
 *   - openai.embedding('text-embedding-3-small')
 *   - google.embedding('gemini-embedding-001')
 *   - cohere.embedding('embed-english-v3.0')
 *   - mistral.embedding('mistral-embed')
 */
export class AiSdkEmbedder implements Embedder {
  private readonly model: EmbeddingModel;
  private readonly providerOptions?: EmbedProviderOptions;
  private cachedDimension: number | undefined;

  constructor(options: AiSdkEmbedderOptions) {
    this.model = options.model;
    this.providerOptions = options.providerOptions;
  }

  get dimension(): number | undefined {
    return this.cachedDimension;
  }

  /** Stable model identity (`provider/modelId`) for the ingest-manifest embedder lock. */
  get id(): string {
    if (typeof this.model === 'string') return this.model;
    return `${this.model.provider}/${this.model.modelId}`;
  }

  async embed(text: string): Promise<readonly number[]> {
    const result = await embed({
      model: this.model,
      value: text,
      ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
    });
    if (!this.cachedDimension) {
      this.cachedDimension = result.embedding.length;
    }
    return result.embedding;
  }

  async embedMany(texts: string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const result = await embedMany({
      model: this.model,
      values: texts,
      ...(this.providerOptions ? { providerOptions: this.providerOptions } : {}),
    });
    if (!this.cachedDimension && result.embeddings.length > 0) {
      this.cachedDimension = result.embeddings[0].length;
    }
    return result.embeddings;
  }
}
