import { randomUUID } from 'node:crypto';

export type ToolPairStatus = 'completed' | 'cancelled' | 'in_progress' | 'validation_failed';

export interface ToolRequestRecord {
  requestId: string;
  name: string;
  args: unknown;
  startedAt: number;
}

export interface ToolResponseRecord {
  requestId: string;
  status: ToolPairStatus;
  result?: unknown;
  error?: string;
  finishedAt: number;
}

export interface ToolCallPair {
  request: ToolRequestRecord;
  response: ToolResponseRecord;
}

export interface CancelledToolResult {
  __tool_status: 'CANCELLED';
  requestId: string;
  name: string;
}

export interface InProgressToolResult {
  __tool_status: 'IN_PROGRESS';
  requestId: string;
  name: string;
  interim?: string;
}

export function cancelledPlaceholder(requestId: string, name: string): CancelledToolResult {
  return { __tool_status: 'CANCELLED', requestId, name };
}

export function inProgressPlaceholder(
  requestId: string,
  name: string,
  interim?: string,
): InProgressToolResult {
  return { __tool_status: 'IN_PROGRESS', requestId, name, interim };
}

export class PairingTracker {
  private pairs = new Map<string, ToolCallPair>();

  openRequest(name: string, args: unknown, requestId: string = randomUUID() as string): string {
    const request: ToolRequestRecord = {
      requestId,
      name,
      args,
      startedAt: Date.now(),
    };
    this.pairs.set(requestId, {
      request,
      response: {
        requestId,
        status: 'in_progress',
        finishedAt: request.startedAt,
      },
    });
    return requestId;
  }

  closePair(
    requestId: string,
    status: ToolPairStatus,
    result?: unknown,
    error?: string,
  ): ToolCallPair {
    const pair = this.pairs.get(requestId);
    if (!pair) {
      throw new Error(`Missing tool request for pairing: ${requestId}`);
    }
    pair.response = {
      requestId,
      status,
      result,
      error,
      finishedAt: Date.now(),
    };
    return pair;
  }

  getPair(requestId: string): ToolCallPair | undefined {
    return this.pairs.get(requestId);
  }

  getAllPairs(): ToolCallPair[] {
    return [...this.pairs.values()];
  }

  hasDanglingRequests(): boolean {
    return this.getAllPairs().some(
      (p) => p.response.status === 'in_progress' && p.response.finishedAt === p.request.startedAt,
    );
  }
}
