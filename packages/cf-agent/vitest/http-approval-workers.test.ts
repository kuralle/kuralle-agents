import { env } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import type { TestApprovalAgent } from './cf-agent-worker.js';

interface ApprovalEnv {
  TEST_APPROVAL_AGENT: DurableObjectNamespace<TestApprovalAgent>;
}

describe('completion-oriented HTTP chat approvals', () => {
  it('returns the frozen approval descriptor needed by an HTTP client to resume', async () => {
    const bindings = env as unknown as ApprovalEnv;
    const stub = await getAgentByName(bindings.TEST_APPROVAL_AGENT, 'http-approval');
    const response = await stub.fetch('http://do/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Please create the case.' }),
    });

    expect(response.ok).toBe(true);
    const body = await response.json() as {
      status: string;
      pendingApproval?: { requestId: string; title: string; description?: string };
    };
    expect(body.status).toBe('approval-required');
    expect(body.pendingApproval).toMatchObject({
      requestId: expect.stringMatching(/^interrupt-/),
      title: 'Create support case?',
      description: 'Send the reviewed summary to a human support queue.',
    });
  });
});
