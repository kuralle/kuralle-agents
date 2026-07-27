import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  ALLOW,
  composePolicies,
  needsApprovalPolicy,
  readOnlyPolicy,
  type Policy,
} from '../../src/runtime/policies/toolPolicy.js';
import { defineTool } from '../../src/tools/effect/index.js';
import { ToolApprovalDeniedError } from '../../src/tools/effect/errors.js';
import { toolDeniedResult } from '../../src/tools/controlResults.js';

const tool = (name: string, needsApproval?: boolean) =>
  defineTool({
    name,
    description: name,
    needsApproval,
    input: z.object({}),
    execute: async () => ({ ok: true }),
  });

describe('tool policy', () => {
  it('defaults to the old behaviour — needsApproval asks, everything else runs', async () => {
    // The compatibility guarantee: adding the Policy seam changes nothing for existing
    // agents. `needsApproval` is published API with real callers in examples and docs.
    expect(await needsApprovalPolicy.decide({ toolName: 'read', args: {}, def: tool('read') })).toEqual(
      ALLOW,
    );
    const gated = await needsApprovalPolicy.decide({
      toolName: 'refund',
      args: {},
      def: tool('refund', true),
    });
    expect(gated.kind).toBe('ask');
  });

  it('readOnlyPolicy denies mutating tools and still honours needsApproval on the rest', async () => {
    const policy = readOnlyPolicy(['write_file']);
    const denied = await policy.decide({ toolName: 'write_file', args: {}, def: tool('write_file') });
    expect(denied.kind).toBe('deny');
    expect(denied.kind === 'deny' && denied.reason).toContain('read-only');

    expect(await policy.decide({ toolName: 'read_file', args: {}, def: tool('read_file') })).toEqual(
      ALLOW,
    );
    const asked = await policy.decide({ toolName: 'deploy', args: {}, def: tool('deploy', true) });
    expect(asked.kind).toBe('ask');
  });

  it('a policy can decide on the ARGUMENTS, which a boolean cannot', async () => {
    // This is the case `needsApproval` structurally cannot express: same tool, different
    // decision depending on what it was asked to do.
    const spendCap: Policy = {
      decide: ({ toolName, args }) =>
        toolName === 'dispatch' && (args as { amount: number }).amount > 250
          ? { kind: 'ask', title: 'Over the spend cap' }
          : ALLOW,
    };
    expect(await spendCap.decide({ toolName: 'dispatch', args: { amount: 180 } })).toEqual(ALLOW);
    expect((await spendCap.decide({ toolName: 'dispatch', args: { amount: 320 } })).kind).toBe('ask');
  });

  it('composition can only ever be more restrictive', async () => {
    // deny wins over a later allow, and ask survives a later allow — so composing policies
    // can never quietly grant a permission that one of the parts refused.
    const denyAll: Policy = { decide: () => ({ kind: 'deny', reason: 'locked' }) };
    const allowAll: Policy = { decide: () => ALLOW };
    const askAll: Policy = { decide: () => ({ kind: 'ask' }) };

    expect((await composePolicies(denyAll, allowAll).decide({ toolName: 't', args: {} })).kind).toBe(
      'deny',
    );
    expect((await composePolicies(allowAll, denyAll).decide({ toolName: 't', args: {} })).kind).toBe(
      'deny',
    );
    expect((await composePolicies(askAll, allowAll).decide({ toolName: 't', args: {} })).kind).toBe(
      'ask',
    );
  });

  it('a policy denial reaches the model as a readable result, not a crash', async () => {
    // Reuses the approval-denied path deliberately: "was not approved, do not retry" is the
    // correct instruction for a rule as well as for a human saying no.
    const error = new ToolApprovalDeniedError('write_file', 'policy', 'read-only agent');
    const result = toolDeniedResult(error.toolName, error.by, error.reason);
    expect(result.message).toContain('was not approved by policy');
    expect(result.message).toContain('read-only agent');
    expect(result.message).toContain('do not retry');
  });
});
