#!/usr/bin/env bash
# Outcomes smoke test.
#
# Verifies: 1 resolved + 1 escalated + 1 auto-abandoned session produces
# auto-resolution rate = resolved / (resolved + escalated) = 0.5.

set -euo pipefail

TMPROOT=$(mktemp -d -t kuralle-outcomes-smoke.XXXXXX)
REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SMOKE_TS="$TMPROOT/outcomes-smoke.ts"

cleanup() {
  rm -rf "$TMPROOT"
}
trap cleanup EXIT

cat > "$SMOKE_TS" <<'TS'
const repoRoot = process.env.REPO_ROOT;
if (!repoRoot) throw new Error('REPO_ROOT missing');

const { Runtime } = await import(`${repoRoot}/packages/kuralle-core/src/runtime/Runtime.ts`);

function makeSession(id, lastActiveAt = '2026-05-26T00:00:00.000Z') {
  const now = new Date(lastActiveAt);
  return {
    id,
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    state: {},
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
  agents: [{ id: 'agent-1', name: 'Agent', instructions: 'Answer.' }],
  defaultAgentId: 'agent-1',
  outcomes: { autoAbandonAfterMs: 10 },
});

try {
  await runtime.sessionStore.save(makeSession('resolved-session'));
  await runtime.markOutcome('resolved-session', 'resolved', {
    markedBy: 'http',
    reason: 'smoke-resolved',
  });

  await runtime.sessionStore.save(makeSession('escalated-session'));
  await runtime.markOutcome('escalated-session', 'escalated', {
    markedBy: 'auto',
    reason: 'smoke-escalated',
  });

  await runtime.sessionStore.save(makeSession('abandoned-session', '2026-05-01T00:00:00.000Z'));
  await new Promise(resolve => setTimeout(resolve, 30));

  const result = await runtime.getAutoResolutionRate({
    window: {
      from: new Date('2026-05-01T00:00:00.000Z'),
      to: new Date('2999-01-01T00:00:00.000Z'),
    },
  });

  if (result.rate !== 0.5) {
    throw new Error(`expected rate 0.5, got ${result.rate}`);
  }
  if (result.sampleSize !== 2) {
    throw new Error(`expected sampleSize 2, got ${result.sampleSize}`);
  }
  const expected = { resolved: 1, escalated: 1, abandoned: 1, unresolved: 0, totalSessions: 3 };
  for (const [key, value] of Object.entries(expected)) {
    if (result.breakdown[key] !== value) {
      throw new Error(`expected breakdown.${key}=${value}, got ${result.breakdown[key]}`);
    }
  }

  console.log('[pass] outcomes auto-resolution rate = 0.5');
  console.log('[pass] resolved/escalated/abandoned breakdown observed');
} finally {
  runtime.dispose();
}
TS

echo "=== kuralle outcomes smoke ==="
REPO_ROOT="$REPO_ROOT" bun "$SMOKE_TS"

