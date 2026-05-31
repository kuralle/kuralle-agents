#!/usr/bin/env bash
# Audit log smoke test.
#
# Offline, deterministic smoke for the audit collector/replay path. It drives
# existing StreamEmitter events through a real Runtime with audit enabled, then
# verifies replayAuditLog returns a chronological compliance trail.

set -euo pipefail

TMPROOT=$(mktemp -d -t kuralle-audit-smoke.XXXXXX)
REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SMOKE_TS="$TMPROOT/audit-log-smoke.ts"

cleanup() {
  rm -rf "$TMPROOT"
}
trap cleanup EXIT

cat > "$SMOKE_TS" <<'TS'
const repoRoot = process.env.REPO_ROOT;
if (!repoRoot) throw new Error('REPO_ROOT missing');

const { Runtime } = await import(`${repoRoot}/packages/kuralle-core/src/runtime/Runtime.ts`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeSession(id) {
  const now = new Date();
  return {
    id,
    conversationId: 'audit-conversation',
    channelId: 'web',
    userId: 'audit-user',
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {
      __ariaAuditSystemPromptHash: 'sha256:smoke',
    },
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    metadata: {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: {},
    handoffHistory: [],
  };
}

const runtime = new Runtime({
  agents: [
    { id: 'agent-1', name: 'Primary', instructions: 'Answer.' },
    { id: 'agent-2', name: 'Specialist', instructions: 'Handle escalations.' },
  ],
  defaultAgentId: 'agent-1',
  audit: { enabled: true },
});

try {
  const services = runtime.turnServices;
  const session = makeSession('audit-smoke-session');
  await runtime.sessionStore.save(session);
  const context = {
    session,
    agentId: 'agent-1',
    stepCount: 1,
    totalTokens: 0,
    handoffStack: [],
    startTime: Date.now(),
    consecutiveErrors: 0,
    toolCallHistory: [],
  };

  async function emit(part) {
    for await (const _ of services.streamEmitter.emit(context, part)) {
      // drain stream part
    }
  }

  await emit({ type: 'pipeline-refinement-rewrite', before: 'need help', after: 'I need help with billing', rationale: 'clarified intent' });
  await emit({ type: 'pipeline-refinement-end', aggregate: 'rewrite', confidence: 0.87, latencyMs: 4 });
  await emit({ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup_invoice', args: { invoiceId: 'inv-123' } });
  await emit({ type: 'tool-result', toolCallId: 'call-1', toolName: 'lookup_invoice', result: { balance: 42, status: 'open' } });
  await emit({ type: 'handoff', from: 'agent-1', to: 'agent-2', reason: 'billing specialist required' });
  await emit({ type: 'escalation-triggered', reason: 'tool-call', confidence: 0.42, handlerOutcome: 'queued', handoverMessage: 'A human will review this.' });
  await emit({ type: 'conversation-outcome', outcome: 'escalated', reason: 'billing queue', markedBy: 'auto' });
  await services.audit.flush(session.id);

  const entries = await runtime.replayAuditLog(session.id);
  const types = entries.map((entry) => entry.type);
  const expected = ['refinement', 'tool-call', 'handoff', 'escalation', 'outcome-marked'];
  for (const type of expected) {
    assert(types.includes(type), `missing audit entry type: ${type}; got ${types.join(',')}`);
  }
  for (let i = 1; i < entries.length; i++) {
    assert(Date.parse(entries[i - 1].at) <= Date.parse(entries[i].at), 'audit entries are not chronological');
  }

  const refinement = entries.find((entry) => entry.type === 'refinement');
  assert(refinement.rewrittenFrom === 'need help', 'refinement rewrittenFrom missing');
  assert(refinement.rewrittenTo === 'I need help with billing', 'refinement rewrittenTo missing');

  const tool = entries.find((entry) => entry.type === 'tool-call');
  assert(tool.toolName === 'lookup_invoice', 'tool-call toolName missing');
  assert(tool.arguments.invoiceId === 'inv-123', 'tool-call arguments missing');
  assert(tool.resultPreview.includes('"balance":42'), `tool-call resultPreview missing: ${tool.resultPreview}`);

  const outcome = entries.find((entry) => entry.type === 'outcome-marked');
  assert(outcome.outcome === 'escalated', 'outcome-marked outcome missing');

  console.log('[pass] audit log replay includes refinement/tool/handoff/escalation/outcome');
  console.log('[pass] audit log entries are chronological');
  console.log('[pass] tool arguments and result preview captured');
} finally {
  runtime.dispose();
}
TS

echo "=== kuralle audit log smoke ==="
REPO_ROOT="$REPO_ROOT" bun "$SMOKE_TS"
