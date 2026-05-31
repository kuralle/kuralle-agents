import type { RunContext, StopCondition, StopConditionResult } from '../types/index.js';

export function maxSteps(n: number): StopCondition {
  return {
    name: `maxSteps(${n})`,
    check: (context) => ({
      shouldStop: context.stepCount >= n,
      reason: context.stepCount >= n ? `Reached maximum steps (${n})` : undefined,
    }),
  };
}

export function tokenBudget(budget: number): StopCondition {
  return {
    name: `tokenBudget(${budget})`,
    check: (context) => ({
      shouldStop: context.totalTokens >= budget,
      reason: context.totalTokens >= budget
        ? `Token budget exceeded (${context.totalTokens}/${budget})`
        : undefined,
    }),
  };
}

export function timeout(ms: number): StopCondition {
  return {
    name: `timeout(${ms}ms)`,
    check: (context) => {
      const elapsed = Date.now() - context.startTime;
      return {
        shouldStop: elapsed >= ms,
        reason: elapsed >= ms ? `Timeout after ${ms}ms` : undefined,
      };
    },
  };
}

export function consecutiveErrors(n: number): StopCondition {
  return {
    name: `consecutiveErrors(${n})`,
    check: (context) => ({
      shouldStop: context.consecutiveErrors >= n,
      reason: context.consecutiveErrors >= n
        ? `Too many consecutive errors (${n})`
        : undefined,
    }),
  };
}

export function loopDetection(windowSize: number = 5): StopCondition {
  return {
    name: `loopDetection(${windowSize})`,
    check: (context) => {
      const history = context.toolCallHistory;
      if (history.length < windowSize * 2) {
        return { shouldStop: false };
      }

      const recent = history.slice(-windowSize);
      const previous = history.slice(-windowSize * 2, -windowSize);

      const recentPattern = recent.map(call => `${call.toolName}:${JSON.stringify(call.args)}`).join('|');
      const previousPattern = previous.map(call => `${call.toolName}:${JSON.stringify(call.args)}`).join('|');

      const isLoop = recentPattern === previousPattern;

      return {
        shouldStop: isLoop,
        reason: isLoop ? 'Detected repetitive loop pattern' : undefined,
      };
    },
  };
}

export function sameToolRepetition(maxRepeats: number = 3): StopCondition {
  return {
    name: `sameToolRepetition(${maxRepeats})`,
    check: (context) => {
      const history = context.toolCallHistory;
      if (history.length < maxRepeats) {
        return { shouldStop: false };
      }

      const recent = history.slice(-maxRepeats);
      const allSameTool = recent.every(call => call.toolName === recent[0].toolName);

      return {
        shouldStop: allSameTool,
        reason: allSameTool
          ? `Tool "${recent[0].toolName}" called ${maxRepeats} times in a row`
          : undefined,
      };
    },
  };
}

export function maxHandoffs(n: number): StopCondition {
  return {
    name: `maxHandoffs(${n})`,
    check: (context) => ({
      shouldStop: context.handoffStack.length >= n,
      reason: context.handoffStack.length >= n
        ? `Maximum handoffs exceeded (${n})`
        : undefined,
    }),
  };
}

export function taskComplete(phrases: string[]): StopCondition {
  return {
    name: 'taskComplete',
    check: (context) => {
      const lastMessage = context.session.messages[context.session.messages.length - 1];
      if (!lastMessage || lastMessage.role !== 'assistant') {
        return { shouldStop: false };
      }

      const content = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);

      const lower = content.toLowerCase();
      const found = phrases.some(phrase => lower.includes(phrase.toLowerCase()));

      return {
        shouldStop: found,
        reason: found ? 'Task completed successfully' : undefined,
      };
    },
  };
}

export function anyOf(...conditions: StopCondition[]): StopCondition {
  return {
    name: `anyOf(${conditions.map(condition => condition.name).join(', ')})`,
    check: (context) => {
      for (const condition of conditions) {
        const result = condition.check(context);
        if (result.shouldStop) {
          return result;
        }
      }
      return { shouldStop: false };
    },
  };
}

export function allOf(...conditions: StopCondition[]): StopCondition {
  return {
    name: `allOf(${conditions.map(condition => condition.name).join(', ')})`,
    check: (context) => {
      const results = conditions.map(condition => condition.check(context));
      const allMet = results.every(result => result.shouldStop);

      if (allMet) {
        return {
          shouldStop: true,
          reason: results.map(result => result.reason).filter(Boolean).join('; '),
        };
      }

      return { shouldStop: false };
    },
  };
}

export const defaultStopConditions: StopCondition[] = [
  maxSteps(20),
  tokenBudget(100000),
  timeout(120000),
  consecutiveErrors(3),
  loopDetection(5),
  maxHandoffs(10),
];

export function checkStopConditions(
  context: RunContext,
  conditions: StopCondition[]
): StopConditionResult {
  for (const condition of conditions) {
    const result = condition.check(context);
    if (result.shouldStop) {
      return result;
    }
  }
  return { shouldStop: false };
}
