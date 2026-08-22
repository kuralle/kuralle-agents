import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { tool } from 'ai';
import { deriveToolOrder } from '../../src/runtime/channels/AiSdkModelTurnLoop.js';
import { resolveNodeTools } from '../../src/runtime/channels/resolveNodeTools.js';
import { reply } from '../../src/types/flow.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/index.js';
import type { AnyTool } from '../../src/types/effectTool.js';

function stubTool(name: string): AnyTool {
  return defineTool({
    name,
    description: `${name} stub`,
    input: z.object({}),
    execute: async () => ({ ok: true, name }),
  });
}

function aiTool(name: string) {
  return tool({
    description: `${name} ai stub`,
    inputSchema: z.object({}),
    execute: async () => 'ok',
  });
}

/** Mirrors the three spread layers the loop advertises to the provider. */
function mergedToolKeys(
  globalTools: Record<string, AnyTool>,
  workingMemoryTools: Record<string, AnyTool>,
  localTools: Record<string, AnyTool>,
): string[] {
  return Object.keys({ ...globalTools, ...workingMemoryTools, ...localTools });
}

describe('AiSdkModelTurnLoop tool order', () => {
  it('deriveToolOrder is identical across two calls with the same merged tools', () => {
    const globalTools = { z_global: stubTool('z_global'), a_global: stubTool('a_global') };
    const workingMemoryTools = { m_memory: stubTool('m_memory') };
    const localTools = { n_node: stubTool('n_node') };

    const first = deriveToolOrder({
      z_global: aiTool('z_global'),
      a_global: aiTool('a_global'),
      m_memory: aiTool('m_memory'),
      n_node: aiTool('n_node'),
    });
    const second = deriveToolOrder({
      z_global: aiTool('z_global'),
      a_global: aiTool('a_global'),
      m_memory: aiTool('m_memory'),
      n_node: aiTool('n_node'),
    });

    expect(first).toEqual(['a_global', 'm_memory', 'n_node', 'z_global']);
    expect(second).toEqual(first);
  });

  it('deriveToolOrder ignores object insertion order from the three source layers', () => {
    const globalToolsA = { z_global: stubTool('z_global'), a_global: stubTool('a_global') };
    const globalToolsB = { a_global: stubTool('a_global'), z_global: stubTool('z_global') };
    const workingMemoryTools = { m_memory: stubTool('m_memory') };
    const localTools = { n_node: stubTool('n_node') };

    const rawOrderTurn1 = mergedToolKeys(globalToolsA, workingMemoryTools, localTools);
    const rawOrderTurn2 = mergedToolKeys(globalToolsB, workingMemoryTools, localTools);
    expect(rawOrderTurn1).not.toEqual(rawOrderTurn2);

    const node = reply({
      id: 'tool_order_probe',
      instructions: 'probe',
      tools: buildToolSet(localTools),
    });
    const resolved = resolveReplyNode(node, {});
    const ctxA = { globalTools: globalToolsA, workingMemoryTools, outOfBandControl: false };
    const ctxB = { globalTools: globalToolsB, workingMemoryTools, outOfBandControl: false };

    const toolsA = resolveNodeTools(resolved, ctxA, {});
    const toolsB = resolveNodeTools(resolved, ctxB, {});

    expect(deriveToolOrder(toolsA)).toEqual(deriveToolOrder(toolsB));
    expect(deriveToolOrder(toolsA)).toEqual(['a_global', 'm_memory', 'n_node', 'z_global']);
  });
});
