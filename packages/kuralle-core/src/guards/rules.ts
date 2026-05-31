import type { EnforcementRule } from '../types/index.js';

export const readBeforeEdit: EnforcementRule = {
  name: 'readBeforeEdit',
  description: 'Must read a file before editing it',
  appliesTo: ['editFile', 'writeFile', 'replaceInFile', 'modifyFile'],

  check: (call, context) => {
    const targetPath = (call.args as { path?: string; filePath?: string }).path
      || (call.args as { path?: string; filePath?: string }).filePath;

    if (!targetPath) return { allowed: true };

    const wasRead = context.previousCalls.some(
      previous => previous.toolName === 'readFile' &&
        ((previous.args as { path?: string }).path === targetPath ||
          (previous.args as { filePath?: string }).filePath === targetPath)
    );

    if (!wasRead) {
      return {
        allowed: false,
        reason: `Cannot edit "${targetPath}" without reading it first`,
        alternative: {
          toolName: 'readFile',
          args: { path: targetPath },
          message: 'Read the file first to understand its contents',
        },
      };
    }

    return { allowed: true };
  },
};

export function createRateLimitRule(
  toolName: string,
  maxCallsPerWindow: number,
  windowMs: number = 60000
): EnforcementRule {
  const callTimestamps: number[] = [];

  return {
    name: `rateLimit-${toolName}`,
    description: `Limit ${toolName} to ${maxCallsPerWindow} calls per ${windowMs}ms`,
    appliesTo: [toolName],

    check: () => {
      const now = Date.now();
      const windowStart = now - windowMs;

      while (callTimestamps.length > 0 && callTimestamps[0] < windowStart) {
        callTimestamps.shift();
      }

      if (callTimestamps.length >= maxCallsPerWindow) {
        const waitTime = Math.ceil((callTimestamps[0] + windowMs - now) / 1000);
        return {
          allowed: false,
          reason: `Rate limit exceeded for ${toolName}. Wait ${waitTime}s.`,
        };
      }

      callTimestamps.push(now);
      return { allowed: true };
    },
  };
}

export function createDependencyRule(
  dependencies: Record<string, string[]>
): EnforcementRule {
  return {
    name: 'dependencyChain',
    description: 'Enforce tool execution order',
    appliesTo: Object.keys(dependencies),

    check: (call, context) => {
      const requiredTools = dependencies[call.toolName];
      if (!requiredTools) return { allowed: true };

      const calledTools = new Set(context.previousCalls.map(previous => previous.toolName));
      const missing = requiredTools.filter(tool => !calledTools.has(tool));

      if (missing.length > 0) {
        return {
          allowed: false,
          reason: `Must call ${missing.join(', ')} before ${call.toolName}`,
          alternative: {
            toolName: missing[0],
            args: {},
            message: `Run ${missing[0]} first`,
          },
        };
      }

      return { allowed: true };
    },
  };
}

export const contentValidation: EnforcementRule = {
  name: 'contentValidation',
  description: 'Validate content before writing to files',
  appliesTo: ['writeFile', 'editFile', 'createFile'],

  check: (call) => {
    const content = (call.args as { content?: string }).content || '';

    const secretPatterns = [
      /api[_-]?key\s*[:=]\s*['"][^'"]{20,}['"]/i,
      /password\s*[:=]\s*['"][^'"]+['"]/i,
      /secret\s*[:=]\s*['"][^'"]{10,}['"]/i,
      /bearer\s+[a-zA-Z0-9-_.]+/i,
    ];

    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        return {
          allowed: false,
          reason: 'Content appears to contain hardcoded secrets',
          reminder: 'Use environment variables for sensitive values',
        };
      }
    }

    return { allowed: true };
  },
};

export function createSequentialLimitRule(maxSequential: number = 3): EnforcementRule {
  return {
    name: `sequentialLimit(${maxSequential})`,
    description: `Prevent more than ${maxSequential} sequential calls to the same tool`,
    appliesTo: '*',

    check: (call, context) => {
      if (context.previousCalls.length < maxSequential) {
        return { allowed: true };
      }

      const recent = context.previousCalls.slice(-maxSequential);
      const allSameTool = recent.every(previous => previous.toolName === call.toolName);

      if (allSameTool) {
        return {
          allowed: false,
          reason: `Cannot call ${call.toolName} more than ${maxSequential} times in a row`,
          reminder: 'Try a different approach or tool',
        };
      }

      return { allowed: true };
    },
  };
}

export const defaultEnforcementRules: EnforcementRule[] = [
  readBeforeEdit,
  contentValidation,
  createSequentialLimitRule(3),
];
