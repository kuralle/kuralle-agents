import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import type { FlowValidationIssueCode } from '../../src/flows/definition/validate/types.js';
import {
  FLOW_BUILDER_AUTHORING_PLAYBOOK,
  FLOW_BUILDER_TOOL_NAMES,
  composeFlowBuilderInstructions,
  createFlowBuilderAgent,
  createFlowBuilderTools,
  type FlowBuilderHost,
  type SaveFlowResult,
} from '../../src/flows/authoring/index.js';
import type { FlowDefinition } from '../../src/flows/definition/types.js';

const ISSUE_CODES = [
  'duplicate-node-id',
  'missing-start',
  'unresolved-transition',
  'unreachable-node',
  'invalid-reply',
  'inline-transition-target',
  'missing-reference',
  'invalid-predicate-reference',
  'incompatible-schema',
  'invalid-template',
  'invalid-map-reference',
  'predicate-too-deep',
] as const satisfies readonly FlowValidationIssueCode[];

type MissingCodes = Exclude<FlowValidationIssueCode, (typeof ISSUE_CODES)[number]>;
const _allIssueCodesCovered: [MissingCodes] extends [never] ? true : MissingCodes = true;
void _allIssueCodesCovered;

const SURFACE_LEAKS = [
  'lookup_account',
  'notify_ops',
  '/api/stored/flows',
  'stored-flows:write',
  'createStoredFlowsRouter',
  'enter_flow',
  'weatherTool',
] as const;

const lookup = defineTool({
  name: 'lookup',
  description: 'Look up refund eligibility for an account id.',
  input: z.object({ accountId: z.string() }),
  execute: async ({ accountId }) => ({ accountId, eligible: true, verdict: 'eligible' }),
});

function hostWith(registered: FlowDefinition[]): FlowBuilderHost {
  return {
    targetAgentId: 'clerk',
    getRuntime: () => ({
      addDynamicFlows: async (defs) => {
        registered.push(...defs);
      },
    }),
    tools: () => ({ lookup }),
    flows: () => [],
    agents: () => [{ id: 'clerk', name: 'Clerk', description: 'Refund clerk' }],
  };
}

function asSave(result: unknown): SaveFlowResult {
  return result as SaveFlowResult;
}

const validDefinition: FlowDefinition = {
  name: 'refund-eligibility',
  description: 'Collect an account id, check eligibility, reply with the verdict.',
  start: 'intake',
  nodes: [
    {
      kind: 'collect',
      id: 'intake',
      schema: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
        required: ['accountId'],
      },
      required: ['accountId'],
      assign: { 'state.accountId': 'accountId' },
      maxTurns: 6,
      next: { goto: 'check' },
    },
    {
      kind: 'action',
      id: 'check',
      tool: 'lookup',
      args: { accountId: { path: 'state.accountId' } },
      bind: 'state.eligibility',
      next: { goto: 'verdict' },
    },
    {
      kind: 'reply',
      id: 'verdict',
      response: { template: 'Account ${state.accountId}: ${state.eligibility.verdict}.' },
      next: { end: 'done' },
    },
  ],
};

describe('flow-builder authoring playbook', () => {
  it('does not mention surface-specific tool names or HTTP routes', () => {
    for (const leak of SURFACE_LEAKS) {
      expect(FLOW_BUILDER_AUTHORING_PLAYBOOK.includes(leak), `playbook leaked "${leak}"`).toBe(false);
    }
  });

  it('names every validator issue code so worked examples stay one-to-one', () => {
    for (const code of ISSUE_CODES) {
      expect(FLOW_BUILDER_AUTHORING_PLAYBOOK.includes(code), `playbook omitted issue code ${code}`).toBe(
        true,
      );
    }
  });

  it('names the four shared builder tools', () => {
    for (const name of Object.values(FLOW_BUILDER_TOOL_NAMES)) {
      expect(FLOW_BUILDER_AUTHORING_PLAYBOOK.includes(name)).toBe(true);
    }
  });
});

describe('createFlowBuilderAgent', () => {
  it('composes playbook then surface policy', () => {
    const registered: FlowDefinition[] = [];
    const agent = createFlowBuilderAgent({
      id: 'builder',
      surfaceInstructions: 'SURFACE_POLICY_MARKER',
      host: hostWith(registered),
    });
    expect(typeof agent.instructions).toBe('string');
    const instructions = agent.instructions as string;
    expect(instructions.startsWith(FLOW_BUILDER_AUTHORING_PLAYBOOK)).toBe(true);
    expect(instructions).toContain('## Surface policy');
    expect(instructions).toContain('SURFACE_POLICY_MARKER');
    expect(instructions.indexOf(FLOW_BUILDER_AUTHORING_PLAYBOOK)).toBeLessThan(
      instructions.indexOf('SURFACE_POLICY_MARKER'),
    );
  });

  it('composeFlowBuilderInstructions keeps extra instructions after the surface block', () => {
    const text = composeFlowBuilderInstructions('surface-here', 'extra-here');
    expect(typeof text).toBe('string');
    expect(text as string).toContain('surface-here');
    expect(text as string).toContain('extra-here');
    expect((text as string).indexOf('surface-here')).toBeLessThan((text as string).indexOf('extra-here'));
  });
});

describe('flow-builder tools', () => {
  it('list_available_tools returns catalog entries with live JSON schemas', async () => {
    const tools = createFlowBuilderTools(hostWith([]));
    const result = await tools[FLOW_BUILDER_TOOL_NAMES.listTools]!.execute({});
    const listed = result as { tools: Array<{ id: string; inputSchema?: { properties?: Record<string, unknown> } }> };
    const entry = listed.tools.find((item) => item.id === 'lookup');
    expect(entry).toBeDefined();
    expect(entry?.inputSchema?.properties).toHaveProperty('accountId');
  });

  it('save_flow returns FlowValidationIssue[] with repair actions instead of throwing', async () => {
    const tools = createFlowBuilderTools(hostWith([]));
    const result = asSave(
      await tools[FLOW_BUILDER_TOOL_NAMES.saveFlow]!.execute({
        definition: {
          name: 'broken',
          description: 'missing start target',
          start: 'missing',
          nodes: [{ kind: 'reply', id: 'say', generate: true, next: { end: 'done' } }],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected validation failure');
    expect(result.error).toBe(true);
    expect(result.issues?.some((issue) => issue.code === 'missing-start')).toBe(true);
    expect(result.issues?.some((issue) => issue.repair?.operation === 'set-transition')).toBe(true);
  });

  it('save_flow registers a valid definition via addDynamicFlows', async () => {
    const registered: FlowDefinition[] = [];
    const tools = createFlowBuilderTools(hostWith(registered));
    const result = asSave(
      await tools[FLOW_BUILDER_TOOL_NAMES.saveFlow]!.execute({ definition: validDefinition }),
    );
    expect(result).toEqual({ ok: true, names: ['refund-eligibility'] });
    expect(registered.map((def) => def.name)).toEqual(['refund-eligibility']);
  });

  it('save_flow flags an unregistered action tool as missing-reference', async () => {
    const tools = createFlowBuilderTools(hostWith([]));
    const result = asSave(
      await tools[FLOW_BUILDER_TOOL_NAMES.saveFlow]!.execute({
        definition: {
          name: 'nope',
          description: 'uses a tool that is not in the catalog',
          start: 'run',
          nodes: [
            {
              kind: 'action',
              id: 'run',
              tool: 'not_a_real_tool',
              next: { end: 'done' },
            },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected missing-reference');
    expect(result.issues?.some((issue) => issue.code === 'missing-reference')).toBe(true);
  });
});
