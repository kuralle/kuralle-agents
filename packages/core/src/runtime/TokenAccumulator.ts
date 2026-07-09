import type { SessionTrace, TurnUsage } from '../types/telemetry.js';

type TurnUsageInput = Omit<
  TurnUsage,
  'cumulativeInputTokens' | 'cumulativeOutputTokens' | 'cumulativeTotalTokens' | 'contextUtilization'
>;

/**
 * Append-only per-session token totals. `record()` is synchronous O(1).
 */
export class TokenAccumulator {
  private _turns: TurnUsage[] = [];
  private _cumInput = 0;
  private _cumOutput = 0;
  private _cumTotal = 0;
  private _peakUtil = 0;
  private _cumCacheRead = 0;

  constructor(private readonly contextWindow?: number) {}

  record(usage: TurnUsageInput): TurnUsage {
    this._cumInput += usage.inputTokens;
    this._cumOutput += usage.outputTokens;
    this._cumTotal += usage.totalTokens;
    if (typeof usage.cacheReadTokens === 'number') {
      this._cumCacheRead += usage.cacheReadTokens;
    }

    const utilization =
      this.contextWindow !== undefined && this.contextWindow > 0
        ? this._cumInput / this.contextWindow
        : undefined;

    if (utilization !== undefined && utilization > this._peakUtil) {
      this._peakUtil = utilization;
    }

    const turn: TurnUsage = {
      ...usage,
      cumulativeInputTokens: this._cumInput,
      cumulativeOutputTokens: this._cumOutput,
      cumulativeTotalTokens: this._cumTotal,
      contextUtilization: utilization,
    };
    this._turns.push(turn);
    return turn;
  }

  get cumulative(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return {
      inputTokens: this._cumInput,
      outputTokens: this._cumOutput,
      totalTokens: this._cumTotal,
    };
  }

  get peakUtilization(): number {
    return this._peakUtil;
  }

  get turns(): TurnUsage[] {
    return this._turns;
  }

  toSessionTraceFields(): Partial<SessionTrace> {
    return {
      totalInputTokens: this._cumInput,
      totalOutputTokens: this._cumOutput,
      totalTokens: this._cumTotal,
      totalCacheReadTokens: this._cumCacheRead,
      peakContextUtilization: this._peakUtil,
      perTurnUsage: [...this._turns],
    };
  }
}
