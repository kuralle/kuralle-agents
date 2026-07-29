import { describe, expect, it } from 'bun:test';
import type { LanguageModel } from 'ai';
import { supportConfig } from '../support.config.js';
import { buildSupportAgent } from '../src/agent.js';
import { createDemoSupportBackend } from '../src/backend.js';

describe('production support agent contract', () => {
  const agent = buildSupportAgent({
    model: {} as LanguageModel,
    backend: createDemoSupportBackend(),
    config: supportConfig,
  });

  it('keeps account reads fresh and approval-gates every support-system write', () => {
    expect(agent.tools?.lookup_order.replay).toBe(false);
    expect(agent.tools?.create_support_case.needsApproval).toBe(true);
    expect(agent.tools?.create_support_case.idempotencyKey?.({
      subject: ' Billing review ',
      details: ' Review this charge. ',
    })).toBe('case:billing review:review this charge.');
  });

  it('has deterministic input/output guards, grounding validation, and a human terminal handoff', () => {
    expect(agent.guardrails?.input?.map((guard) => guard.id)).toEqual([
      'prompt-injection-guard',
      'pii-input-guard',
      'moderation-guard',
    ]);
    expect(agent.guardrails?.output?.map((guard) => guard.id)).toEqual([
      'pii-output-guard',
      'moderation-output-guard',
    ]);
    expect(agent.validate?.map((validator) => validator.name)).toEqual(['grounding-validator']);
    expect(agent.handoffs).toContain('human');
    expect(agent.knowledge?.autoRetrieve).toBe(true);
  });

  it('packages operational procedure as progressively loaded skill content', () => {
    expect(agent.skills).toMatchObject({
      name: 'support-operations',
      allowedTools: ['lookup_order', 'create_support_case'],
      body: expect.stringContaining('The create tool pauses for customer approval.'),
    });
  });
});
