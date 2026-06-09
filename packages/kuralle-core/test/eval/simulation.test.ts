import { describe, expect, it, mock, afterEach } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { stubModel } from '../core-durable/helpers.js';
import {
  simulateConversation,
  createJudge,
  runSimulationSuite,
} from '../../src/eval/simulation.js';
import type { ChannelDriver } from '../../src/types/channel.js';

afterEach(() => {
  mock.restore();
});

/**
 * Mock `generateObject` for both roles: the simulated user (system prompt
 * mentions "role-playing a customer") and the judge ("evaluation judge").
 */
function mockModels(opts: {
  userTurns: Array<{ message: string | null; status: 'continue' | 'goal-met' | 'give-up' }>;
  judgeScores?: Array<{ key: string; score: number; rationale: string }>;
}) {
  let userCall = 0;
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      generateObject: async (args: { system?: string }) => {
        if (args.system?.includes('role-playing a customer')) {
          const turn = opts.userTurns[Math.min(userCall, opts.userTurns.length - 1)]!;
          userCall += 1;
          return { object: turn };
        }
        return {
          object: {
            scores: opts.judgeScores ?? [
              { key: 'goalCompletion', score: 5, rationale: 'done' },
              { key: 'grounding', score: 4, rationale: 'ok' },
            ],
            summary: 'solid conversation',
          },
        };
      },
    };
  });
}

function echoRuntime(reply = 'Sure — your order #42 is confirmed.') {
  const driver: ChannelDriver = {
    async runAgentTurn() {
      return { text: reply, toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
  const runtime = createRuntime({
    agents: [defineAgent({ id: 'a', instructions: 'shop agent', model: stubModel })],
    defaultAgentId: 'a',
    sessionStore: new MemoryStore(),
  });
  return {
    run: (opts: { sessionId?: string; input?: unknown }) =>
      runtime.run({ ...opts, driver } as Parameters<typeof runtime.run>[0]),
  };
}

describe('simulateConversation', () => {
  it('drives a persona against the runtime until goal-met', async () => {
    mockModels({
      userTurns: [
        { message: 'Hi, I want a chocolate cake delivered Friday', status: 'continue' },
        { message: 'Perfect, thanks!', status: 'goal-met' },
      ],
    });

    const result = await simulateConversation({
      runtime: echoRuntime(),
      persona: { profile: 'busy parent', goal: 'order a cake' },
      userModel: stubModel,
      maxTurns: 5,
    });

    expect(result.endedBy).toBe('goal-met');
    expect(result.transcript[0]).toEqual({
      role: 'user',
      content: 'Hi, I want a chocolate cake delivered Friday',
    });
    expect(result.transcript[1]?.role).toBe('assistant');
    expect(result.transcript[1]?.content).toContain('order #42');
    // closing user line included
    expect(result.transcript[result.transcript.length - 1]?.content).toBe('Perfect, thanks!');
  });

  it('uses the persona openingMessage verbatim for the first turn', async () => {
    mockModels({ userTurns: [{ message: null, status: 'goal-met' }] });
    const result = await simulateConversation({
      runtime: echoRuntime(),
      persona: { profile: 'x', goal: 'y', openingMessage: 'EXACT OPENING' },
      userModel: stubModel,
      maxTurns: 3,
    });
    expect(result.transcript[0]?.content).toBe('EXACT OPENING');
  });

  it('stops at maxTurns and reports give-up', async () => {
    mockModels({
      userTurns: [{ message: 'still trying...', status: 'continue' }],
    });
    const looped = await simulateConversation({
      runtime: echoRuntime('please hold'),
      persona: { profile: 'x', goal: 'y' },
      userModel: stubModel,
      maxTurns: 3,
    });
    expect(looped.endedBy).toBe('max-turns');
    expect(looped.turns).toBe(3);

    mockModels({ userTurns: [{ message: 'forget it', status: 'give-up' }] });
    const gaveUp = await simulateConversation({
      runtime: echoRuntime(),
      persona: { profile: 'x', goal: 'y', openingMessage: 'hello' },
      userModel: stubModel,
      maxTurns: 3,
    });
    expect(gaveUp.endedBy).toBe('user-gave-up');
  });
});

describe('createJudge', () => {
  it('aggregates dimension scores into a pass/fail verdict', async () => {
    mockModels({
      userTurns: [],
      judgeScores: [
        { key: 'goalCompletion', score: 5, rationale: 'completed' },
        { key: 'grounding', score: 4, rationale: 'no invented claims' },
        { key: 'tone', score: 4, rationale: 'friendly' },
      ],
    });
    const judge = createJudge({ model: stubModel });
    const verdict = await judge.judge(
      {
        transcript: [{ role: 'user', content: 'hi' }],
        turns: 1,
        endedBy: 'goal-met',
        sessionId: 's',
        toolsCalled: ['create_order'],
        escalated: false,
      },
      { profile: 'x', goal: 'y' },
    );
    expect(verdict.overall).toBeCloseTo(13 / 3);
    expect(verdict.pass).toBe(true);
    expect(verdict.scores.grounding?.rationale).toBe('no invented claims');
  });

  it('fails when the user gave up, regardless of scores', async () => {
    mockModels({
      userTurns: [],
      judgeScores: [{ key: 'goalCompletion', score: 5, rationale: 'x' }],
    });
    const judge = createJudge({ model: stubModel });
    const verdict = await judge.judge(
      {
        transcript: [],
        turns: 2,
        endedBy: 'user-gave-up',
        sessionId: 's',
        toolsCalled: [],
        escalated: false,
      },
      { profile: 'x', goal: 'y' },
    );
    expect(verdict.pass).toBe(false);
  });
});

describe('runSimulationSuite', () => {
  it('runs all scenarios and gates on every verdict', async () => {
    mockModels({
      userTurns: [{ message: 'done already', status: 'goal-met' }],
      judgeScores: [{ key: 'goalCompletion', score: 5, rationale: 'x' }],
    });
    const suite = await runSimulationSuite({
      runtime: echoRuntime(),
      scenarios: [
        { name: 'happy path', persona: { profile: 'a', goal: 'g', openingMessage: 'hi' } },
        { name: 'second', persona: { profile: 'b', goal: 'g2', openingMessage: 'yo' } },
      ],
      userModel: stubModel,
      judge: createJudge({ model: stubModel }),
    });
    expect(suite.scenarios).toHaveLength(2);
    expect(suite.passed).toBe(true);
    expect(suite.passRate).toBe(1);
  });
});
