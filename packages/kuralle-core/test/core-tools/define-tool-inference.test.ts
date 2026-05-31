import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineTool } from '../../src/tools/effect/defineTool.js';

describe('defineTool inference', () => {
  it('infers input args from zod schema without casts', () => {
    const lookup = defineTool({
      description: 'Look up order',
      input: z.object({ orderId: z.string() }),
      execute: async (args) => {
        const id: string = args.orderId;
        return { id };
      },
    });

    expect(lookup.name).toBe('look_up_order');
  });
});
