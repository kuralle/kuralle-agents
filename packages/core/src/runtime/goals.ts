import { z } from 'zod';
import type { LanguageModel, ModelMessage } from 'ai';
import type { RunContext } from '../types/run-context.js';
import { instrumentedGenerateObject } from './channels/instrumentModelCall.js';

export const GOALS_KEY = '__goals';

export type GoalStatus = 'open' | 'resolved';

export interface TrackedGoal {
  topic: string;
  status: GoalStatus;
  lastTurn: number;
  note?: string;
}

export type GoalsState = Record<string, unknown>;

const goalPatchSchema = z.object({
  add: z
    .array(
      z.object({
        topic: z.string(),
        note: z.union([z.string(), z.null()]),
      }),
    )
    .default([]),
  resolve: z.array(z.string()).default([]),
});

function isTrackedGoal(value: unknown): value is TrackedGoal {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const goal = value as TrackedGoal;
  return (
    typeof goal.topic === 'string' &&
    (goal.status === 'open' || goal.status === 'resolved') &&
    typeof goal.lastTurn === 'number'
  );
}

function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase();
}

export function getGoals(state: GoalsState): TrackedGoal[] {
  const raw = state[GOALS_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isTrackedGoal);
}

export function addGoal(
  state: GoalsState,
  topic: string,
  lastTurn = 0,
  note?: string,
): GoalsState {
  const trimmed = topic.trim();
  if (!trimmed) {
    return state;
  }

  const goals = getGoals(state);
  const key = normalizeTopic(trimmed);
  const existingIndex = goals.findIndex((goal) => normalizeTopic(goal.topic) === key);

  if (existingIndex >= 0) {
    const next = [...goals];
    const existing = next[existingIndex]!;
    next[existingIndex] = {
      ...existing,
      topic: trimmed,
      status: 'open',
      lastTurn,
      note: note ?? existing.note,
    };
    return { ...state, [GOALS_KEY]: next };
  }

  const entry: TrackedGoal = { topic: trimmed, status: 'open', lastTurn };
  if (note) {
    entry.note = note;
  }
  return { ...state, [GOALS_KEY]: [...goals, entry] };
}

export function resolveGoal(state: GoalsState, topic: string, lastTurn = 0): GoalsState {
  const trimmed = topic.trim();
  if (!trimmed) {
    return state;
  }

  const key = normalizeTopic(trimmed);
  const goals = getGoals(state);
  let changed = false;
  const next = goals.map((goal) => {
    if (normalizeTopic(goal.topic) !== key) {
      return goal;
    }
    changed = true;
    return { ...goal, status: 'resolved' as const, lastTurn };
  });

  if (!changed) {
    return state;
  }
  return { ...state, [GOALS_KEY]: next };
}

export function listOpenGoals(state: GoalsState): string[] {
  return getGoals(state)
    .filter((goal) => goal.status === 'open')
    .map((goal) => goal.topic);
}

export function projectGoalsPrompt(goals: TrackedGoal[]): string {
  const open = goals.filter((goal) => goal.status === 'open');
  if (open.length === 0) {
    return '';
  }
  const parts = open.map((goal) =>
    goal.note ? `${goal.topic} (${goal.status}, ${goal.note})` : `${goal.topic} (${goal.status})`,
  );
  return `Open threads: ${parts.join('; ')}`;
}

export function projectGoalsPromptFromState(state: GoalsState): string {
  return projectGoalsPrompt(getGoals(state));
}

function readSessionTurn(state: GoalsState): number {
  const value = state['__ariaSessionTurn'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function latestExchange(messages: ModelMessage[]): { user: string; assistant: string } | null {
  let assistant = '';
  let user = '';

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!assistant && message?.role === 'assistant' && typeof message.content === 'string') {
      assistant = message.content;
      continue;
    }
    if (assistant && message?.role === 'user' && typeof message.content === 'string') {
      user = message.content;
      break;
    }
  }

  if (!user || !assistant) {
    return null;
  }
  return { user, assistant };
}

function applyGoalPatch(state: GoalsState, patch: z.infer<typeof goalPatchSchema>): GoalsState {
  let next = state;
  const turn = readSessionTurn(state);

  for (const topic of patch.resolve) {
    next = resolveGoal(next, topic, turn);
  }
  for (const entry of patch.add) {
    const note = entry.note ?? undefined;
    next = addGoal(next, entry.topic, turn, note);
  }
  return next;
}

export async function updateGoalsFromTurn(
  ctx: RunContext,
  model: LanguageModel,
): Promise<void> {
  const exchange = latestExchange(ctx.runState.messages);
  if (!exchange) {
    return;
  }

  const currentGoals = getGoals(ctx.session.workingMemory);
  const goalsSummary =
    currentGoals.length === 0
      ? 'none'
      : currentGoals
          .map((goal) =>
            goal.note
              ? `${goal.topic} [${goal.status}] — ${goal.note}`
              : `${goal.topic} [${goal.status}]`,
          )
          .join('\n');

  const object = await instrumentedGenerateObject(ctx, {
    model,
    schema: goalPatchSchema,
    temperature: 0,
    controlPath: true,
    system:
      'You track conversational threads (goals/topics the user may circle back to). ' +
      'Given the latest exchange and current tracked threads, return only schema fields. ' +
      'Add a topic when the user opens a new thread or revisits one not yet tracked. ' +
      'Resolve a topic when the exchange clearly completes or abandons it. ' +
      'Keep topics short labels (1-4 words). Do not invent threads unrelated to the exchange.',
    prompt:
      `Current tracked threads:\n${goalsSummary}\n\n` +
      `Latest user message:\n${exchange.user}\n\n` +
      `Latest assistant message:\n${exchange.assistant}\n\n` +
      'Return add[] for new/reopened open topics and resolve[] for completed topics.',
  });

  const patched = applyGoalPatch(ctx.session.workingMemory, object);
  ctx.session.workingMemory = patched;
}