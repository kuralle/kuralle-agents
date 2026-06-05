/**
 * Trace collector for WS transport e2e tests.
 *
 * Records protocol messages, binary audio, timing, and lifecycle events
 * for post-run assertions and latency reporting.
 */

export interface TraceEntry {
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
}

export interface TurnLatency {
  turnIndex: number;
  label: string;
  startedAt: number;
  firstTextAt: number | null;
  firstAudioAt: number | null;
  turnSettledAt: number | null;
  timeToFirstTextMs: number | null;
  timeToFirstAudioMs: number | null;
  totalTurnMs: number | null;
}

export interface RuntimeMetricEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export class TraceCollector {
  entries: TraceEntry[] = [];
  jsonMessages: Array<{ type: string; data: Record<string, unknown>; timestamp: number }> = [];
  binaryChunks: Array<{ size: number; timestamp: number }> = [];
  turnLatencies: TurnLatency[] = [];
  runtimeMetrics: RuntimeMetricEvent[] = [];

  private _currentTurn: TurnLatency | null = null;

  record(type: string, data: Record<string, unknown> = {}): void {
    this.entries.push({ timestamp: Date.now(), type, data });
  }

  recordJsonMessage(parsed: Record<string, unknown>): void {
    const type = String(parsed.type ?? 'unknown');
    this.jsonMessages.push({ type, data: parsed, timestamp: Date.now() });
    this.record(`ws:${type}`, parsed);

    // Track first text latency
    if (type === 'agent_text' && this._currentTurn && !this._currentTurn.firstTextAt) {
      this._currentTurn.firstTextAt = Date.now();
      this._currentTurn.timeToFirstTextMs =
        this._currentTurn.firstTextAt - this._currentTurn.startedAt;
    }
  }

  recordRuntimeMetric(type: string, data: Record<string, unknown> = {}): void {
    const timestamp = Date.now();
    this.runtimeMetrics.push({ type, timestamp, data });
    this.record(`metric:${type}`, data);
  }

  recordBinaryChunk(size: number): void {
    const now = Date.now();
    this.binaryChunks.push({ size, timestamp: now });

    // Track first audio latency
    if (this._currentTurn && !this._currentTurn.firstAudioAt) {
      this._currentTurn.firstAudioAt = now;
      this._currentTurn.timeToFirstAudioMs =
        this._currentTurn.firstAudioAt - this._currentTurn.startedAt;
    }
  }

  startTurn(turnIndex: number, label: string): void {
    this._currentTurn = {
      turnIndex,
      label,
      startedAt: Date.now(),
      firstTextAt: null,
      firstAudioAt: null,
      turnSettledAt: null,
      timeToFirstTextMs: null,
      timeToFirstAudioMs: null,
      totalTurnMs: null,
    };
  }

  endTurn(): void {
    if (this._currentTurn) {
      this._currentTurn.turnSettledAt = Date.now();
      this._currentTurn.totalTurnMs =
        this._currentTurn.turnSettledAt - this._currentTurn.startedAt;
      this.turnLatencies.push(this._currentTurn);
      this._currentTurn = null;
    }
  }

  // ─── Query Helpers ─────────────────────────────────────────────────────

  hasMessageType(type: string): boolean {
    return this.jsonMessages.some((m) => m.type === type);
  }

  getMessages(type: string): Array<Record<string, unknown>> {
    return this.jsonMessages.filter((m) => m.type === type).map((m) => m.data);
  }

  hasEntry(type: string): boolean {
    return this.entries.some((e) => e.type === type);
  }

  get totalBinaryBytes(): number {
    return this.binaryChunks.reduce((sum, c) => sum + c.size, 0);
  }

  // ─── Reporting ─────────────────────────────────────────────────────────

  printSummary(): void {
    console.log('\n  ┌──────────────────────────────────────────────────────');
    console.log('  │ TRACE SUMMARY');
    console.log('  ├──────────────────────────────────────────────────────');

    const messageTypes = new Map<string, number>();
    for (const msg of this.jsonMessages) {
      messageTypes.set(msg.type, (messageTypes.get(msg.type) ?? 0) + 1);
    }
    for (const [type, count] of messageTypes) {
      console.log(`  │ JSON: ${type} × ${count}`);
    }
    console.log(`  │ Binary chunks: ${this.binaryChunks.length} (${this.totalBinaryBytes} bytes)`);
    console.log('  ├──────────────────────────────────────────────────────');

    if (this.turnLatencies.length > 0) {
      console.log('  │ LATENCY REPORT');
      console.log('  ├──────────────────────────────────────────────────────');
      for (const t of this.turnLatencies) {
        console.log(`  │ Turn ${t.turnIndex + 1}: "${t.label}"`);
        console.log(`  │   → First text:  ${t.timeToFirstTextMs !== null ? t.timeToFirstTextMs + 'ms' : 'N/A'}`);
        console.log(`  │   → First audio: ${t.timeToFirstAudioMs !== null ? t.timeToFirstAudioMs + 'ms' : 'N/A'}`);
        console.log(`  │   → Total:       ${t.totalTurnMs !== null ? t.totalTurnMs + 'ms' : 'N/A'}`);
      }
    }

    console.log('  └──────────────────────────────────────────────────────');
  }
}
