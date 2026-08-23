import type {
  LoggedEvent,
  Runtime,
  SessionEventLog,
  SignalDelivery,
  TurnResult,
  UserInputContent,
} from '@kuralle-agents/core';

export interface Cursor {
  sessionId: string;
  index: number;
}

export interface InputRequestOption {
  id: string;
  label: string;
  description?: string;
}

export interface InputRequest {
  requestId: string;
  kind: 'approval' | 'signal';
  prompt: string;
  description?: string;
  signalName?: string;
  toolName?: string;
  options?: InputRequestOption[];
}

export interface SendOptions {
  agentId?: string;
  userId?: string;
  abortSignal?: AbortSignal;
  idempotencyKey?: string;
  callerInstructions?: string;
}

export interface InputResponse {
  requestId: string;
  decision?: 'approve' | 'deny';
  reason?: string;
  signalName?: string;
  payload?: unknown;
  actor?: SignalDelivery['actor'];
}

export interface Session {
  readonly id: string;
  send(message: string | UserInputContent, opts?: SendOptions): Promise<TurnResponse>;
  respond(responses: InputResponse[], opts?: SendOptions): Promise<TurnResponse>;
  cancel(reason?: string): Promise<void>;
  stream(opts?: {
    startIndex?: number;
    follow?: boolean;
    signal?: AbortSignal;
  }): AsyncIterable<LoggedEvent>;
  snapshot(): Promise<{ events: LoggedEvent[]; cursor: Cursor }>;
}

export interface TurnResponse extends AsyncIterable<LoggedEvent> {
  result(): Promise<TurnResult>;
}

export interface Auth {
  token?: string;
  headers?: Record<string, string>;
}

export type Target =
  | { kind: 'local'; runtime: Runtime; eventLog: SessionEventLog }
  | { kind: 'http'; url: string; agentName?: string; auth?: Auth }
  | { kind: 'cloudflare'; url: string; agentName: string; auth?: Auth };

export interface SessionManager {
  create(): Session;
  attach(sessionId: string, cursor?: Cursor): Session;
}

export interface Client {
  readonly sessions: SessionManager;
}
