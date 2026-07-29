import { describe, expect, test } from 'bun:test';
import type { AgentTrace } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildKitchenSinkAgent, buildOkfAgent, PARALLEL_TOOL_NAMES } from '../kitchenSink.js';
import { assessScenario } from '../run.js';
import { ALL_SCENARIOS, CORE_FLOW_SCENARIOS } from '../scenarios.js';

const appDir = resolve(import.meta.dir, '..');
const repoRoot = resolve(appDir, '../../..');

describe('stress matrix', () => {
  test('covers every Core flow example exactly once', async () => {
    const files = (await readdir(resolve(repoRoot, 'packages/core/examples/flows')))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `packages/core/examples/flows/${name}`)
      .sort();
    expect(CORE_FLOW_SCENARIOS.map((scenario) => scenario.source).sort()).toEqual(files);
    expect(new Set(ALL_SCENARIOS.map((scenario) => scenario.id)).size).toBe(ALL_SCENARIOS.length);
  });

  test('kitchen sink has explicit schemas and separated skill storage', async () => {
    const agent = buildKitchenSinkAgent({} as LanguageModel);
    const node = agent.flows?.[0]?.nodes[0];
    expect(node?.kind).toBe('reply');
    if (node?.kind !== 'reply' || typeof node.tools === 'function') throw new Error('unexpected node shape');
    for (const name of PARALLEL_TOOL_NAMES) {
      const tool = node.tools?.[name] as { inputSchema?: unknown } | undefined;
      expect(tool?.inputSchema).toBeDefined();
    }

    const skillStore = agent.skills;
    if (!skillStore || Array.isArray(skillStore) || typeof skillStore === 'string' || !('list' in skillStore)) {
      throw new Error('expected a filesystem skill store');
    }
    expect((await skillStore.list()).map((skill) => skill.name)).toEqual(['operations-check']);
    expect(await agent.tools?.workspace?.execute({ op: 'cat', path: '/accounts/ACME-42.md' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('read_skill_resource'),
    });
    await skillStore.loadResource('operations-check', 'references/checklist.md');
    await expect(agent.tools?.workspace?.execute({ op: 'ls', path: '/skills' })).rejects.toThrow('ENOENT');
    expect(await agent.tools?.workspace?.execute({ op: 'cat', path: '/accounts/ACME-42.md' })).toMatchObject({
      ok: true,
      content: expect.stringContaining('ap-south-1'),
    });
  });

  test('OKF navigator cannot bypass skill disclosure through workspace', async () => {
    const agent = buildOkfAgent({} as LanguageModel);
    const skillStore = agent.skills;
    if (!skillStore || Array.isArray(skillStore) || typeof skillStore === 'string' || !('list' in skillStore)) {
      throw new Error('expected a filesystem skill store');
    }
    expect((await skillStore.list()).map((skill) => skill.name)).toEqual(['okf-navigator']);
    expect(await agent.tools?.workspace?.execute({ op: 'cat', path: '/index.md' })).toMatchObject({
      ok: false,
      error: expect.stringContaining('load_skill'),
    });
    // One body read represents runtime validation; the second represents the
    // model-facing load_skill call and unlocks grounded workspace navigation.
    await skillStore.loadBody('okf-navigator');
    await skillStore.loadBody('okf-navigator');
    expect(await agent.tools?.workspace?.execute({ op: 'cat', path: '/index.md' })).toMatchObject({
      ok: true,
      path: '/index.md',
    });
  });

  test('assessor requires TTFT and proves parallel overlap', () => {
    const scenario = ALL_SCENARIOS.find((item) => item.id === 'kitchen-sink')!;
    const trace = fakeTrace();
    expect(assessScenario(scenario, [trace]).failures).toEqual([]);

    trace.spans.find((span) => span.kind === 'turn')!.attributes.ttftMs = undefined;
    trace.spans.find((span) => span.attributes.toolName === 'calculate_tax')!.startTime = 250;
    expect(assessScenario(scenario, [trace]).failures).toEqual([
      'everyTurnHasTtft',
      'parallelToolOverlap',
    ]);
  });
});

function fakeTrace(): AgentTrace {
  const traceId = '0123456789abcdef0123456789abcdef';
  const base = {
    traceId,
    status: 'ok' as const,
    attributes: { sessionId: 'test' },
  };
  const toolNames = [
    'load_skill',
    'read_skill_resource',
    'workspace',
    ...PARALLEL_TOOL_NAMES,
  ];
  return {
    traceId,
    sessionId: 'test',
    answer: 'ap-south-1 ORBIT-7 in stock $7.99 $12.50',
    usedTool: true,
    toolCalls: toolNames.map((name) => ({ name, args: {} })),
    toolResults: [],
    startedAt: 0,
    endedAt: 300,
    spans: [
      { ...base, spanId: 'turn', name: 'turn', kind: 'turn', startTime: 0, endTime: 300, attributes: { sessionId: 'test', ttftMs: 50 } },
      { ...base, spanId: 'flow', name: 'flow:operations-check', kind: 'flow', startTime: 10, endTime: 280, attributes: { sessionId: 'test', activeFlow: 'operations-check' } },
      ...toolNames.map((name, index) => ({
        ...base,
        spanId: `tool-${index}`,
        name: `tool:${name}`,
        kind: 'tool' as const,
        startTime: PARALLEL_TOOL_NAMES.includes(name as typeof PARALLEL_TOOL_NAMES[number]) ? 100 : 20 + index,
        endTime: PARALLEL_TOOL_NAMES.includes(name as typeof PARALLEL_TOOL_NAMES[number]) ? 200 : 21 + index,
        attributes: { sessionId: 'test', toolName: name },
      })),
    ],
  };
}
