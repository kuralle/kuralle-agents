import { describe, expect, it } from 'bun:test';

import { BuiltinPersonas, resolvePersonaExperiment } from '../src/persona/index.ts';
import type { PersonaExperimentConfig } from '../src/persona/index.ts';
import type { Session } from '../src/types/index.ts';

describe('resolvePersonaExperiment', () => {
  it('allocationPct=0.2 routes about 20% of distinct keys to the variant', () => {
    const experiment = makeExperiment({ allocationPct: 0.2 });
    let variants = 0;

    for (let i = 0; i < 1000; i++) {
      const session = makeSession(`session-${i}`, `user-${i}`);
      const resolution = resolvePersonaExperiment(experiment, session, fixedNow);
      if (resolution.experiment.cohort === 'variant') variants += 1;
    }

    expect(variants).toBeGreaterThanOrEqual(150);
    expect(variants).toBeLessThanOrEqual(250);
  });

  it('same key resolves to the same cohort always', () => {
    const experiment = makeExperiment({ allocationPct: 0.2 });
    const cohorts = new Set<string>();

    for (let i = 0; i < 20; i++) {
      const session = makeSession(`session-${i}`, 'stable-user');
      cohorts.add(resolvePersonaExperiment(experiment, session, fixedNow).experiment.cohort);
    }

    expect(cohorts.size).toBe(1);
  });

  it('session metadata pins cohort across turns', () => {
    const session = makeSession('session-1', 'user-1');
    const experiment = makeExperiment({
      allocationPct: 1,
      key: () => 'first-key',
    });

    const first = resolvePersonaExperiment(experiment, session, fixedNow);
    expect(first.persona.name).toBe('warm');
    expect(session.metadata?.personaExperiment).toEqual({
      cohort: 'variant',
      personaName: 'warm',
      allocatedAt: '2026-05-26T00:00:00.000Z',
    });

    const second = resolvePersonaExperiment(
      makeExperiment({
        allocationPct: 0,
        key: () => 'second-key',
      }),
      session,
      fixedNow,
    );

    expect(second.experiment.cohort).toBe('variant');
    expect(second.persona.name).toBe('warm');
    expect(session.metadata?.personaExperiment).toEqual({
      cohort: 'variant',
      personaName: 'warm',
      allocatedAt: '2026-05-26T00:00:00.000Z',
    });
  });

  it('defaults allocation key to userId before session id', () => {
    const experiment = makeExperiment({
      allocationPct: 1,
      key: undefined,
    });
    const session = makeSession('session-1', 'user-1');

    resolvePersonaExperiment(experiment, session, fixedNow);

    expect(session.metadata?.personaExperiment?.cohort).toBe('variant');
  });
});

function makeExperiment(overrides: Partial<PersonaExperimentConfig> = {}): PersonaExperimentConfig {
  return {
    control: BuiltinPersonas.formal,
    variant: BuiltinPersonas.warm,
    allocationPct: 0.2,
    ...overrides,
  };
}

function makeSession(id: string, userId?: string): Session {
  const now = new Date('2026-05-26T00:00:00.000Z');
  return {
    id,
    userId,
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    state: {},
    metadata: {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: {},
    handoffHistory: [],
  };
}

function fixedNow(): Date {
  return new Date('2026-05-26T00:00:00.000Z');
}
