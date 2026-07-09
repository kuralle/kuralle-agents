import type { AgentConfig } from '../types/agentConfig.js';

export interface EvalScenario {
  name: string;
  description?: string;
  agent: AgentConfig;
  turns: EvalTurn[];
  mode: 'text' | 'voice';
}

export interface EvalTurn {
  input: string;
  audioFixture?: string;
  expect?: {
    toolCalls?: string[];
    noToolCalls?: string[];
    flowTransition?: { from: string; to: string };
    extractionFields?: Record<string, unknown>;
    responseContains?: string[];
    responseNotContains?: string[];
    maxLatencyMs?: number;
  };
}

export interface ScenarioScore {
  scenario: string;
  mode: 'text' | 'voice';
  passed: boolean;
  turnScores: TurnScore[];
  aggregate: {
    passRate: number;
    totalTurns: number;
    passedTurns: number;
    failedTurns: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    toolCallAccuracy: number;
    extractionAccuracy: number;
  };
}

export interface TurnScore {
  turnIndex: number;
  input: string;
  response: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  latencyMs: number;
  toolsCalled: string[];
  flowTransitions: Array<{ from: string; to: string }>;
}
