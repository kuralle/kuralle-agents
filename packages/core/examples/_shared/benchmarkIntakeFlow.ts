import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';

export function createBenchmarkIntakeFlow() {
  const done = reply({
    id: 'done',
    instructions: 'Thank the customer briefly.',
    next: () => ({ end: 'complete' }),
  });

  const collectReason = collect({
    id: 'collect_reason',
    schema: z.object({ reason: z.string().min(1) }),
    required: ['reason'],
    instructions: (missing) =>
      `Ask why the customer is calling today. Be brief. Missing: ${missing.join(', ') || 'none'}.`,
    onComplete: () => done,
  });

  const collectName = collect({
    id: 'collect_name',
    schema: z.object({ name: z.string().min(1) }),
    required: ['name'],
    instructions: (missing) =>
      `Ask for the customer's full name. Be brief. Missing: ${missing.join(', ') || 'none'}.`,
    onComplete: () => collectReason,
  });

  return defineFlow({
    name: 'intake',
    description: 'Collect customer name and reason for calling',
    start: collectName,
    nodes: [collectName, collectReason, done],
  });
}
