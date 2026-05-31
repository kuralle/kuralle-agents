import { createHash } from 'node:crypto';
import type {
  AgentKnowledgeOverrides,
  HarnessStreamPart,
  KnowledgeRetrievalResult,
  RetrievalCacheAdapter,
  Session,
  SourceRef,
} from '../../types/index.js';

export const PENDING_CITATIONS_KEY = '__pendingCitations';

export interface CitationRetrievalProvider {
  retrieve(
    query: string,
    cache: RetrievalCacheAdapter | undefined,
    agentOverrides?: AgentKnowledgeOverrides,
    isVoice?: boolean,
  ): Promise<{
    results: KnowledgeRetrievalResult[];
    citations?: SourceRef[];
    events: HarnessStreamPart[];
  }>;
}

export interface CitationRetrievalResult {
  results: KnowledgeRetrievalResult[];
  citations: SourceRef[];
  events: HarnessStreamPart[];
}

export async function retrieveWithCitations(
  provider: CitationRetrievalProvider,
  query: string,
  cache: RetrievalCacheAdapter | undefined,
  agentOverrides?: AgentKnowledgeOverrides,
  isVoice = false,
): Promise<CitationRetrievalResult> {
  const raw = await provider.retrieve(query, cache, agentOverrides, isVoice);
  return {
    ...raw,
    citations: normalizeCitations(raw.results, raw.citations),
  };
}

export function normalizeCitations(
  results: KnowledgeRetrievalResult[],
  nativeCitations?: readonly SourceRef[],
): SourceRef[] {
  const candidates =
    nativeCitations && nativeCitations.length > 0
      ? nativeCitations
      : results.map(sourceRefFromResult);

  const byId = new Map<string, SourceRef>();
  for (const citation of candidates) {
    const existing = byId.get(citation.id);
    if (!existing || (citation.score ?? 0) > (existing.score ?? 0)) {
      byId.set(citation.id, citation);
    }
  }

  return Array.from(byId.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function getPendingCitations(session: Session): SourceRef[] {
  const pending = session.workingMemory[PENDING_CITATIONS_KEY];
  return Array.isArray(pending) ? (pending as SourceRef[]) : [];
}

export function popPendingCitations(session: Session): SourceRef[] {
  const citations = getPendingCitations(session);
  delete session.workingMemory[PENDING_CITATIONS_KEY];
  return citations;
}

export function withCitationMetadata<T extends { role?: unknown; metadata?: unknown }>(
  message: T,
  citations: readonly SourceRef[],
): T {
  if (message.role !== 'assistant' || citations.length === 0) return message;
  const metadata =
    typeof message.metadata === 'object' && message.metadata !== null
      ? { ...(message.metadata as Record<string, unknown>) }
      : {};
  return {
    ...message,
    metadata: {
      ...metadata,
      citations,
    },
  };
}

export function withCitationsOnLastAssistantMessage<T extends { role?: unknown; metadata?: unknown }>(
  messages: readonly T[],
  citations: readonly SourceRef[],
): T[] {
  if (citations.length === 0) return [...messages];

  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index--) {
    if (next[index].role === 'assistant') {
      next[index] = withCitationMetadata(next[index], citations);
      break;
    }
  }
  return next;
}

function sourceRefFromResult(result: KnowledgeRetrievalResult): SourceRef {
  const sourceId = result.sourceId || `synthetic-${hashShort(result.text)}`;
  return {
    id: sourceId,
    title: stringMetadata(result.metadata, 'title') ?? stringMetadata(result.metadata, 'sourceTitle'),
    url: stringMetadata(result.metadata, 'url') ?? stringMetadata(result.metadata, 'sourceUrl'),
    lastModified: stringMetadata(result.metadata, 'lastModified'),
    score: result.relevanceScore ?? result.score,
  };
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hashShort(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
