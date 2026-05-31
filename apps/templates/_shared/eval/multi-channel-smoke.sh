#!/usr/bin/env bash
# Multi-channel continuity smoke.
#
# Offline, deterministic smoke that proves a web turn and a later Vapi
# OpenAI-compatible turn for the same verified user share one conversation.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
TMPROOT=$(mktemp -d "$REPO_ROOT/packages/kuralle-core/.kuralle-multi-channel-smoke.XXXXXX")
SMOKE_TS="$TMPROOT/multi-channel-smoke.ts"

cleanup() {
  rm -rf "$TMPROOT"
}
trap cleanup EXIT

cat > "$SMOKE_TS" <<'TS'
const repoRoot = process.env.REPO_ROOT;
if (!repoRoot) throw new Error('REPO_ROOT missing');

const { MockLanguageModelV3, simulateReadableStream } = await import('ai/test');
const { Runtime } = await import(`${repoRoot}/packages/kuralle-core/src/runtime/Runtime.ts`);
const { InMemoryConversationStore } = await import(`${repoRoot}/packages/kuralle-core/src/conversations/index.ts`);
const { createOpenAICompatRouter } = await import(`${repoRoot}/packages/kuralle-hono-server/src/openaiCompat.ts`);

const DEFAULT_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function continuityModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const serialized = JSON.stringify(prompt);
      const text = serialized.includes('What order id did I give you') && serialized.includes('A123')
        ? 'Your order id is A123.'
        : 'I have noted order A123.';
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

async function drain(stream) {
  const parts = [];
  let text = '';
  for await (const part of stream) {
    parts.push(part);
    if (part.type === 'text-delta') text += part.text;
  }
  return { parts, text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const streamEvents = [];
const runtime = new Runtime({
  agents: [{
    id: 'agent-1',
    name: 'Agent',
    instructions: 'Answer with the available conversation context.',
    model: continuityModel(),
  }],
  defaultAgentId: 'agent-1',
  safety: { outputModerators: [] },
  channels: { conversationStore: new InMemoryConversationStore() },
  deferPersistence: false,
  hooks: {
    onStreamPart: async (_context, part) => {
      streamEvents.push(part);
    },
  },
});

try {
  const web = await drain(runtime.run({
    input: 'My order id is A123.',
    sessionId: 'web-session',
    userId: 'multi-channel-user',
    channelId: 'web',
  }).events);
  assert(web.text.includes('A123'), `web turn did not complete as expected: ${web.text}`);

  const router = createOpenAICompatRouter({ runtime });
  const response = await router.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'kuralle',
      stream: false,
      user: 'multi-channel-user',
      messages: [{ role: 'user', content: 'What order id did I give you?' }],
      call: { id: 'vapi-call-1' },
    }),
  });
  assert(response.status === 200, `Vapi turn returned HTTP ${response.status}`);
  const body = await response.json();
  const answer = body.choices?.[0]?.message?.content ?? '';
  assert(answer.includes('A123'), `Vapi turn did not recall prior web context: ${answer}`);

  const webSession = await runtime.getSession('web-session');
  const voiceSession = await runtime.getSession('vapi-vapi-call-1');
  assert(webSession, 'web session missing');
  assert(voiceSession, 'voice session missing');
  assert(
    webSession.conversationId === voiceSession.conversationId,
    `conversationId mismatch: ${webSession.conversationId} !== ${voiceSession.conversationId}`,
  );
  assert(voiceSession.channelId === 'voice', `voice session channelId mismatch: ${voiceSession.channelId}`);
  assert(
    streamEvents.some((part) =>
      part.type === 'channel-switched' &&
      part.from === 'web' &&
      part.to === 'voice' &&
      part.conversationId === voiceSession.conversationId
    ),
    'channel-switched event missing',
  );

  console.log('[pass] web and Vapi turns share conversationId');
  console.log('[pass] Vapi turn inferred channelId=voice');
  console.log('[pass] Vapi turn recalled prior web context');
  console.log('[pass] channel-switched event emitted');
} finally {
  runtime.dispose();
}
TS

echo "=== kuralle multi-channel smoke ==="
REPO_ROOT="$REPO_ROOT" bun "$SMOKE_TS"
