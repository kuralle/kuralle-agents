import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  buildToolSet,
  defineTool,
  rawToolsFromSet,
} from '../../src/tools/effect/defineTool.js';

describe('flow-local tool metadata', () => {
  test('survives duplicate Core module instances without entering provider schemas', () => {
    const effect = defineTool({
      name: 'local_probe',
      description: 'Probe a local executor.',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const tools = buildToolSet({ local_probe: effect });

    // A source-loaded AgentConfig and a built CLI runtime use distinct module
    // WeakMaps, but Symbol.for resolves to the same process-global key.
    const key = Symbol.for('@kuralle-agents/core.raw-tools-by-set');
    expect((tools as unknown as Record<symbol, unknown>)[key]).toEqual({ local_probe: effect });
    expect(rawToolsFromSet(tools)).toEqual({ local_probe: effect });
    expect(Object.keys(tools)).toEqual(['local_probe']);
    expect(JSON.stringify(tools)).not.toContain('raw-tools-by-set');
  });
});
