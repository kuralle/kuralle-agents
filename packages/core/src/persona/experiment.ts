import crypto from 'node:crypto';

import type { Session } from '../types/session.js';
import type { PersonaConfig, PersonaExperimentCohort } from './types.js';

export interface PersonaExperimentConfig {
  control: PersonaConfig;
  variant: PersonaConfig;
  allocationPct: number;
  key?: (session: Session) => string;
}

export interface PersonaExperimentResolution {
  persona: PersonaConfig;
  experiment: {
    cohort: PersonaExperimentCohort;
    allocationPct: number;
  };
}

export function resolvePersonaExperiment(
  experiment: PersonaExperimentConfig,
  session: Session,
  now: () => Date = () => new Date(),
): PersonaExperimentResolution {
  const allocationPct = clampAllocation(experiment.allocationPct);
  const pinned = session.metadata?.personaExperiment;
  const cohort = pinned?.cohort ?? allocateCohort(experiment, session, allocationPct);
  const persona = cohort === 'variant' ? experiment.variant : experiment.control;

  if (!pinned) {
    ensureSessionMetadata(session).personaExperiment = {
      cohort,
      personaName: persona.name,
      allocatedAt: now().toISOString(),
    };
  }

  return {
    persona,
    experiment: {
      cohort,
      allocationPct,
    },
  };
}

function allocateCohort(
  experiment: PersonaExperimentConfig,
  session: Session,
  allocationPct: number,
): PersonaExperimentCohort {
  const key = experiment.key?.(session) ?? defaultAllocationKey(session);
  const bucket = hashToBucket(key);
  return bucket < allocationPct ? 'variant' : 'control';
}

function defaultAllocationKey(session: Session): string {
  return session.conversationId ?? session.userId ?? session.id;
}

function hashToBucket(key: string): number {
  const digest = crypto.createHash('sha1').update(key).digest('hex');
  const value = Number.parseInt(digest.slice(0, 8), 16);
  return value / 0xffffffff;
}

function clampAllocation(allocationPct: number): number {
  if (allocationPct < 0) return 0;
  if (allocationPct > 1) return 1;
  return allocationPct;
}

function ensureSessionMetadata(session: Session): NonNullable<Session['metadata']> {
  if (!session.metadata) {
    session.metadata = {
      createdAt: session.createdAt,
      lastActiveAt: session.updatedAt,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: session.handoffHistory,
    };
  }
  return session.metadata;
}
