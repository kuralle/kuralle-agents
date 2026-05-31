#!/usr/bin/env bash
# Persona smoke test.
#
# Offline, deterministic smoke for first-class personas. It exercises the
# real Runtime + prompt assembly + stream events with an ai/test mock model
# that changes output based on the active Persona section.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
TMPROOT=$(mktemp -d "$REPO_ROOT/packages/kuralle-core/.kuralle-persona-smoke.XXXXXX")
SMOKE_TS="$TMPROOT/persona-smoke.ts"

cleanup() {
  rm -rf "$TMPROOT"
}
trap cleanup EXIT

cat > "$SMOKE_TS" <<'TS'
const repoRoot = process.env.REPO_ROOT;
if (!repoRoot) throw new Error('REPO_ROOT missing');

const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
const { Runtime } = await import(`${repoRoot}/packages/kuralle-core/src/runtime/Runtime.ts`);
const { BuiltinPersonas } = await import(`${repoRoot}/packages/kuralle-core/src/persona/index.ts`);

const DEFAULT_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function personaAwareModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const serialized = JSON.stringify(prompt);
      const text = serialized.includes('## Persona: formal')
        ? 'We can help with your account question. Best regards'
        : 'Happy to help — let us figure this out together. Thanks!';
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'm1' },
            { type: 'text-delta', id: 'm1', delta: text },
            { type: 'text-end', id: 'm1' },
            { type: 'finish', usage: DEFAULT_USAGE, finishReason: { unified: 'stop', raw: undefined } },
          ],
        }),
      };
    },
  });
}

async function runPersona(persona, sessionId) {
  const runtime = new Runtime({
    agents: [{
      id: 'agent-1',
      name: 'Agent',
      instructions: 'Answer the customer question.',
      persona,
      model: personaAwareModel(),
    }],
    defaultAgentId: 'agent-1',
    safety: { outputModerators: [] },
  });

  const parts = [];
  let text = '';
  try {
    for await (const part of runtime.run({
      input: 'Can you help me understand my account?',
      sessionId,
      userId: 'persona-smoke-user',
    }).events) {
      parts.push(part);
      if (part.type === 'text-delta') text += part.text;
    }
  } finally {
    runtime.dispose();
  }

  return { parts, text };
}

const formal = await runPersona(BuiltinPersonas.formal, 'persona-formal');
const warm = await runPersona(BuiltinPersonas.warm, 'persona-warm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  formal.parts.some((part) => part.type === 'persona-applied' && part.personaName === 'formal'),
  'formal persona-applied event missing',
);
assert(
  warm.parts.some((part) => part.type === 'persona-applied' && part.personaName === 'warm'),
  'warm persona-applied event missing',
);
assert(
  formal.parts.some((part) => part.type === 'agent-start' && part.personaName === 'formal'),
  'formal agent-start personaName missing',
);
assert(
  warm.parts.some((part) => part.type === 'agent-start' && part.personaName === 'warm'),
  'warm agent-start personaName missing',
);
assert(formal.text !== warm.text, 'formal and warm responses should differ');
assert(formal.text.includes('Best regards'), `formal sign-off missing: ${formal.text}`);
assert(warm.text.includes('Thanks!'), `warm sign-off missing: ${warm.text}`);
assert(warm.text.length > formal.text.length, 'warm response should be more conversational by length');

console.log('[pass] persona-applied stream events observed');
console.log('[pass] agent-start includes personaName');
console.log('[pass] formal and warm responses differ by sign-off and length');
TS

echo "=== kuralle persona smoke ==="
REPO_ROOT="$REPO_ROOT" bun "$SMOKE_TS"
