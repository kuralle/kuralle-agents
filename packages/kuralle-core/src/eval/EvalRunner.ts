import type { LanguageModel } from 'ai';
import { createRuntime } from '../runtime/Runtime.js';
import { newSessionId } from '../runtime/openRun.js';
import type { AgentConfig } from '../types/agentConfig.js';
import type { Hooks } from '../types/hooks.js';
import type { EvalScenario, ScenarioScore, TurnScore } from './types.js';
import { aggregateScores, scoreTurn } from './scoring.js';

export class EvalRunner {
  constructor(private config: { model: LanguageModel; hooks?: Hooks }) {}

  async runText(scenario: EvalScenario): Promise<ScenarioScore> {
    const agent = scenario.agent;
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: this.config.model,
      hooks: this.config.hooks,
    });

    let sessionId: string = newSessionId();
    const turnScores: TurnScore[] = [];

    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i]!;
      const startTime = Date.now();
      let response = '';
      const toolsCalled: string[] = [];
      const transitions: Array<{ from: string; to: string }> = [];

      const handle = runtime.run({ input: turn.input, sessionId });
      for await (const part of handle.events) {
        if (part.type === 'text-delta') {
          response += part.text;
        }
        if (part.type === 'tool-call') {
          toolsCalled.push(part.toolName);
        }
        if (part.type === 'flow-transition') {
          transitions.push({ from: part.from, to: part.to });
        }
        if (part.type === 'done') {
          sessionId = part.sessionId;
        }
      }
      await handle;

      const latencyMs = Date.now() - startTime;
      const checks = scoreTurn(turn.expect, response, toolsCalled, transitions, latencyMs);

      turnScores.push({
        turnIndex: i,
        input: turn.input,
        response: response.trim(),
        passed: checks.length === 0 ? true : checks.every((c) => c.passed),
        checks,
        latencyMs,
        toolsCalled,
        flowTransitions: transitions,
      });
    }

    return aggregateScores(scenario.name, scenario.mode, turnScores);
  }
}
