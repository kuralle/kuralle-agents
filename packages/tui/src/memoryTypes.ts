export interface MemoryBlockSnapshot {
  key: string;
  scope: string;
  chars: number;
  limit: number;
  content: string;
}

export interface MemoryExtractedSnapshot {
  slug: string;
  scope: string;
  value: unknown;
  updatedAt: string;
}

export interface MemorySnapshot {
  blocks: MemoryBlockSnapshot[];
  extracted: MemoryExtractedSnapshot[];
}

export type FetchMemory = (opts: { userId: string; agentId?: string }) => Promise<MemorySnapshot>;
