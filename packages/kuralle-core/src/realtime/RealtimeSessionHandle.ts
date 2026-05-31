export interface RealtimeSessionHandle {
  readonly sessionId: string;
  readonly callId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
