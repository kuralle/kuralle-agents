import { describe, expect, it } from 'bun:test';
import type { InputResponse } from '@kuralle-agents/client';
import { buildApprovalResponse } from '../src/approvalRespond.js';
import { sampleApprovalInterrupt } from './helpers.js';

/** Payload shape `kuralle send --approve|--deny` passes to `session.respond`. */
function cliSendRespondPayload(
  interrupt: typeof sampleApprovalInterrupt,
  decision: 'approve' | 'deny',
): InputResponse[] {
  return [{ requestId: interrupt.requestId, decision }];
}

describe('approval respond parity', () => {
  it('matches the CLI respond payload byte-for-byte', () => {
    for (const decision of ['approve', 'deny'] as const) {
      const cli = JSON.stringify(cliSendRespondPayload(sampleApprovalInterrupt, decision));
      const tui = JSON.stringify(buildApprovalResponse(sampleApprovalInterrupt, decision));
      expect(tui).toBe(cli);
    }
  });
});
