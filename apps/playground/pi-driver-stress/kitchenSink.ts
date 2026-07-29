import {
  buildToolSet,
  createFsTool,
  defineAgent,
  defineFlow,
  defineTool,
  fsSkillStore,
  reply,
  type AgentConfig,
} from '@kuralle-agents/core';
import { InMemoryFs, okfBundleToFs } from '@kuralle-agents/fs';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

export const PARALLEL_TOOL_NAMES = [
  'lookup_inventory',
  'quote_shipping',
  'calculate_tax',
] as const;

const OPERATIONS_SKILL = `---
name: operations-check
description: Evidence procedure for checkout readiness, inventory, shipping, and tax checks.
---

# Operations check

Before answering an operations-check request:

1. Read \`references/checklist.md\` with \`read_skill_resource\`.
2. Read \`/accounts/ACME-42.md\` and \`/runbooks/checkout.md\` with \`workspace\`.
3. Call \`lookup_inventory\`, \`quote_shipping\`, and \`calculate_tax\` together in one model step.
4. Report every exact value returned by the files and tools. Never guess.
`;

const OPERATIONS_WORKSPACE_FILES = {
  '/accounts/ACME-42.md': '# Account ACME-42\n\n- Region: ap-south-1\n- Plan: enterprise',
  '/runbooks/checkout.md': '# Checkout recovery\n\n- Playbook codename: ORBIT-7\n- Owner: commerce reliability',
};

const OPERATIONS_SKILL_FILES = {
  '/skills/operations-check/SKILL.md': OPERATIONS_SKILL,
  '/skills/operations-check/references/checklist.md': [
    '# Required evidence',
    '',
    'The final response must state the account region, playbook codename, inventory status, shipping quote, and tax estimate.',
  ].join('\n'),
};

function delayedEvidence<T extends Record<string, unknown>>(result: T) {
  return async (): Promise<T & { startedAt: number; endedAt: number }> => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 220));
    return { ...result, startedAt, endedAt: Date.now() };
  };
}

export function buildKitchenSinkAgent(model: LanguageModel): AgentConfig {
  // Deliberately separate the workspace and skill filesystems. This prevents a
  // model from bypassing progressive skill disclosure by reading /skills with
  // the generic workspace tool, and validates that both drivers really use the
  // SkillsCapability tool surface.
  const workspaceFs = new InMemoryFs(OPERATIONS_WORKSPACE_FILES);
  const skillFs = new InMemoryFs(OPERATIONS_SKILL_FILES);
  const baseSkillStore = fsSkillStore(skillFs);
  let checklistReads = 0;
  const guardedSkillStore = {
    list: () => baseSkillStore.list(),
    loadBody: (name: string) => baseSkillStore.loadBody(name),
    async loadResource(name: string, resourcePath: string) {
      const resource = await baseSkillStore.loadResource(name, resourcePath);
      if (name === 'operations-check' && resourcePath === 'references/checklist.md') {
        checklistReads += 1;
      }
      return resource;
    },
  };
  const checklistRequired = <T extends Record<string, unknown>>(
    execute: () => Promise<T>,
  ) => async (): Promise<T | { ok: false; error: string }> => {
    if (checklistReads === 0) {
      return {
        ok: false,
        error: 'Read references/checklist.md with read_skill_resource before collecting operations evidence.',
      };
    }
    return execute();
  };
  const rawWorkspace = createFsTool({ fs: workspaceFs, readOnly: true });
  const guardedWorkspace = {
    ...rawWorkspace,
    execute: async (...input: Parameters<typeof rawWorkspace.execute>) => {
      if (checklistReads === 0) {
        const args = input[0] as { op?: string };
        return {
          op: args.op ?? 'read',
          ok: false,
          error: 'Read references/checklist.md with read_skill_resource before accessing operations evidence.',
        };
      }
      return rawWorkspace.execute(...input);
    },
  };
  const tools = {
    lookup_inventory: defineTool({
      name: 'lookup_inventory',
      description: 'Look up checkout inventory status. Call alongside the shipping and tax tools.',
      input: z.object({}),
      parallelSafe: true,
      replay: false,
      execute: checklistRequired(delayedEvidence({ inventory: 'in stock' })),
    }),
    quote_shipping: defineTool({
      name: 'quote_shipping',
      description: 'Quote checkout shipping. Call alongside the inventory and tax tools.',
      input: z.object({}),
      parallelSafe: true,
      replay: false,
      execute: checklistRequired(delayedEvidence({ shipping: '$7.99' })),
    }),
    calculate_tax: defineTool({
      name: 'calculate_tax',
      description: 'Calculate checkout tax. Call alongside the inventory and shipping tools.',
      input: z.object({}),
      parallelSafe: true,
      replay: false,
      execute: checklistRequired(delayedEvidence({ tax: '$12.50' })),
    }),
  };

  const check = reply({
    id: 'gather-operations-evidence',
    instructions: [
      'Complete the operations check before emitting prose.',
      'Your FIRST tool call MUST be load_skill({ name: "operations-check" }).',
      'Then call read_skill_resource({ name: "operations-check", path: "references/checklist.md" }).',
      'NEVER use workspace to list, search, or read /skills; the workspace filesystem intentionally does not contain skill files.',
      'Read /accounts/ACME-42.md and /runbooks/checkout.md with workspace using op "cat".',
      'Then issue lookup_inventory, quote_shipping, and calculate_tax in the SAME response so they execute concurrently.',
      'Only after every result exists, answer in one concise sentence with region, playbook, inventory, shipping, and tax.',
    ].join(' '),
    tools: buildToolSet(tools),
    next: () => ({ end: 'Operations check complete.' }),
  });

  return defineAgent({
    id: 'pi-stress-kitchen-sink',
    name: 'Pi Driver Kitchen Sink',
    model,
    instructions: [
      'You are an evidence-first operations agent. Follow the active flow exactly and use tools before prose.',
      'Skill access is only through load_skill and read_skill_resource.',
      'Never call workspace on /skills or any descendant because skills are deliberately mounted on a separate capability filesystem.',
    ].join(' '),
    workspace: { fs: workspaceFs, readOnly: true },
    skills: guardedSkillStore,
    tools: {
      workspace: guardedWorkspace,
    },
    flows: [
      defineFlow({
        name: 'operations-check',
        description: 'Run the complete checkout operations evidence check.',
        binding: true,
        start: check,
        nodes: [check],
      }),
    ],
    limits: { maxSteps: 12, maxToolConcurrency: 4 },
  });
}

const OKF_FILES = {
  '/index.md': [
    '# Knowledge index',
    '',
    '- [Weekly active users](/metrics/weekly_active_users.md)',
    '- [Events table](/tables/events.md)',
  ].join('\n'),
  '/metrics/weekly_active_users.md': `---
type: metric
title: Weekly active users
description: Count of distinct active users in a seven-day window.
---

# Definition

Weekly active users is the distinct count of \`user_id\` in [events](/tables/events.md) over the trailing seven days.
`,
  '/tables/events.md': `---
type: table
title: Events
description: Product activity event facts.
---

# Schema

- \`user_id\`: stable user identity column
- \`event_at\`: UTC event timestamp
`,
};

const OKF_SKILL_FILES = {
  '/skills/okf-navigator/SKILL.md': `---
name: okf-navigator
description: Navigate the OKF knowledge bundle to answer metric and schema questions.
---

# OKF navigation

Read \`/index.md\` with the workspace tool, then follow the matching concept links. Read every linked metric and table file before answering. Use only bundle evidence.
`,
};

export function buildOkfAgent(model: LanguageModel): AgentConfig {
  const fs = okfBundleToFs(OKF_FILES);
  const skillFs = new InMemoryFs(OKF_SKILL_FILES);
  const baseSkillStore = fsSkillStore(skillFs);
  let skillBodyLoads = 0;
  const guardedSkillStore = {
    list: () => baseSkillStore.list(),
    async loadBody(name: string) {
      skillBodyLoads += 1;
      return baseSkillStore.loadBody(name);
    },
    loadResource: (name: string, path: string) => baseSkillStore.loadResource(name, path),
  };
  const rawWorkspace = createFsTool({ fs, readOnly: true });
  const guardedWorkspace = {
    ...rawWorkspace,
    execute: async (...input: Parameters<typeof rawWorkspace.execute>) => {
      // Agent wiring reads each body once to validate allowed-tools. The second
      // load is the model's actual load_skill call. Until then, make the
      // capability prerequisite explicit as a recoverable tool result.
      if (skillBodyLoads < 2) {
        const args = input[0] as { op?: string };
        return {
          op: args.op ?? 'read',
          ok: false,
          error: 'Load the okf-navigator skill with load_skill before accessing the OKF workspace.',
        };
      }
      return rawWorkspace.execute(...input);
    },
  };
  const navigate = reply({
    id: 'navigate-okf',
    instructions: [
      'Your first action MUST be load_skill for okf-navigator; do not infer its body from this prompt.',
      'After loading it, carry out the procedure it returns with workspace.',
      'Never inspect /skills with workspace; the skill capability uses a separate filesystem.',
      'Do not answer unless the current trace contains a successful load_skill result plus the required workspace evidence.',
    ].join(' '),
    next: () => ({ end: 'OKF navigation complete.' }),
  });

  return defineAgent({
    id: 'pi-stress-okf',
    name: 'Pi Driver OKF Analyst',
    model,
    instructions: 'You are a grounded data analyst. The required procedure exists only in the disclosed okf-navigator skill; load it before using the workspace or answering. Never use workspace on /skills because skill storage is a separate capability filesystem.',
    skills: guardedSkillStore,
    tools: { workspace: guardedWorkspace },
    flows: [
      defineFlow({
        name: 'okf-navigation',
        description: 'Answer questions by navigating the mounted OKF bundle.',
        binding: true,
        start: navigate,
        nodes: [navigate],
      }),
    ],
    limits: { maxSteps: 10, maxToolConcurrency: 4 },
  });
}
