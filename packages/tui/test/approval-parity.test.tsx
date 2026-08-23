import { describe, expect, it } from 'bun:test';
import { buildApprovalResponse } from '@kuralle-agents/client';
import { buildApprovalResponse as tuiBuild } from '../src/approvalRespond.js';
import { sampleApprovalInterrupt } from './helpers.js';

// Parity used to be asserted against a copy of the CLI payload written inside this file, which is
// green whatever the CLI does. Both surfaces now call one exported builder, so the only thing worth
// asserting is that the TUI did not quietly reintroduce its own.
describe('approval respond parity', () => {
  it('the TUI sends exactly the shared builder\'s payload', () => {
    for (const decision of ['approve', 'deny'] as const) {
      expect(tuiBuild).toBe(buildApprovalResponse);
      expect(tuiBuild(sampleApprovalInterrupt, decision)).toEqual([
        { requestId: sampleApprovalInterrupt.requestId, decision },
      ]);
    }
  });
});
