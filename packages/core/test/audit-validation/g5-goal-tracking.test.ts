import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { PromptBuilder } from '../../src/prompts/PromptBuilder.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import {
  GOALS_KEY,
  addGoal,
  getGoals,
  listOpenGoals,
  projectGoalsPrompt,
  resolveGoal,
} from '../../src/runtime/goals.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { makeTestSession, stubModel } from '../core-durable/helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';

describe('G5: structured goal/thread tracking', () => {
  it('addGoal, listOpenGoals, resolveGoal, and projectGoalsPrompt', () => {
    let state: Record<string, unknown> = {};
    state = addGoal(state, 'premium');
    expect(listOpenGoals(state)).toEqual(['premium']);
    expect(getGoals(state)[0]?.status).toBe('open');

    const prompt = projectGoalsPrompt(getGoals(state));
    expect(prompt).toContain('premium');
    expect(prompt).toContain('open');

    state = resolveGoal(state, 'premium');
    expect(listOpenGoals(state)).toEqual([]);
    expect(getGoals(state)[0]?.status).toBe('resolved');
    expect(projectGoalsPrompt(getGoals(state))).toBe('');
  });

  it('projectGoalsPrompt is empty when no open goals', () => {
    expect(projectGoalsPrompt([])).toBe('');
    expect(projectGoalsPrompt([{ topic: 'done', status: 'resolved', lastTurn: 1 }])).toBe('');
  });

  it('projects open goals into PromptBuilder next to working memory', () => {
    const prompt = new PromptBuilder()
      .withSessionMemory({
        workingMemory: [{ label: 'USER', content: 'Prefers email.' }],
        openGoalsPrompt: 'Open threads: premium (open)',
      })
      .build();

    expect(prompt).toContain('Prefers email.');
    expect(prompt).toContain('Open threads: premium (open)');
  });

  it('does not populate __goals when trackGoals is off (default)', async () => {
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'Happy to help with premium plans.', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'tell me about premium' };
      },
    };

    const agent = defineAgent({
      id: 'support',
      instructions: 'You are support.',
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'g5-off-default';
    const session = makeTestSession(sessionId);
    await sessionStore.save(session);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'support',
      sessionStore,
      defaultModel: stubModel,
    });

    const handle = runtime.run({ sessionId, input: 'tell me about premium', driver });
    for await (const _part of handle.events) {
      // drain
    }
    await handle;

    const saved = await sessionStore.get(sessionId);
    expect(saved?.workingMemory[GOALS_KEY]).toBeUndefined();
  });
});