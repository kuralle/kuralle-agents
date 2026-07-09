export interface ReplayPart {
  type: string;
  [key: string]: unknown;
}

export interface TranscriptEvent {
  sessionId: string;
  agentId: string;
  timestamp: string;
  part: ReplayPart;
  fullText?: string;
}

export interface ReplayStats {
  totalEvents: number;
  byType: Record<string, number>;
  sessions: string[];
  agents: string[];
}
