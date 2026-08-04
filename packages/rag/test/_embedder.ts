/**
 * Which embedding provider the live RAG suites run against.
 *
 * These tests were written against `gemini-embedding-001` because it is free and good.
 * That is a fine default and a bad hard requirement: when the Google key is absent — or
 * present and rejected, which is the case that actually bit — every live suite fails for a
 * reason that has nothing to do with retrieval.
 *
 * So the provider is selected, not assumed. OpenAI first when its key is present, Google
 * otherwise. The suites that assert ordinary retrieval behaviour work on either.
 *
 * Task types are the exception. `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT` are a Gemini
 * feature with no OpenAI equivalent, so any test asserting *asymmetric* embedding behaviour
 * must gate on {@link hasTaskTypeSupport} rather than silently comparing two identical
 * embedders and passing for the wrong reason.
 */
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import type { EmbeddingModel } from 'ai';

export type EmbeddingProvider = 'openai' | 'google';

export const EMBEDDING_PROVIDER: EmbeddingProvider = process.env.OPENAI_API_KEY
  ? 'openai'
  : 'google';

/** True only when the active provider actually implements retrieval task types. */
export const hasTaskTypeSupport = EMBEDDING_PROVIDER === 'google';

/** True when the active provider has a key at all — suites should skip, not fail, without one. */
export const hasEmbeddingCredentials =
  EMBEDDING_PROVIDER === 'openai'
    ? Boolean(process.env.OPENAI_API_KEY)
    : Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

export const EMBEDDING_MODEL_ID =
  EMBEDDING_PROVIDER === 'openai' ? 'text-embedding-3-small' : 'gemini-embedding-001';

export function embeddingModel(): EmbeddingModel<string> {
  return EMBEDDING_PROVIDER === 'openai'
    ? openai.embedding('text-embedding-3-small')
    : google.embedding('gemini-embedding-001');
}

/**
 * Provider options for a retrieval task type, or `undefined` when the active provider has
 * no such concept. Passing `undefined` keeps the dual-embedder call sites identical across
 * providers instead of forking them.
 */
export function taskTypeOptions(
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
): Record<string, Record<string, unknown>> | undefined {
  return hasTaskTypeSupport ? { google: { taskType } } : undefined;
}
