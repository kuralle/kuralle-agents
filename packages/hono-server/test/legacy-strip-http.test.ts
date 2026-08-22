import { describe, expect, it } from 'bun:test';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import { InvalidCallerMessagesError } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '../src/index.ts';
import { createOpenAICompatRouter } from '../src/openaiCompat.ts';

// The real error core throws, not a hand-built stand-in: the routes key off its `name`
// tag, so a plain Error here would assert nothing about the mapping that actually ships.
const validationError = new InvalidCallerMessagesError('seedMessages', 0);

describe('legacy strip HTTP errors', () => {
  it('POST /api/chat returns 400 for caller message validation failures', async () => {
    const runtime = createMockRuntime([], {
      onRun: () => {
        throw validationError;
      },
    });
    const app = createKuralleChatRouter({ runtime });

    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain(
      "seedMessages must not contain role: 'system' messages",
    );
  });

  it('POST /v1/chat/completions returns 400 for caller message validation failures', async () => {
    const runtime = createMockRuntime([], {
      onRun: () => {
        throw validationError;
      },
    });
    const app = createOpenAICompatRouter({ runtime });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("seedMessages must not contain role: 'system' messages");
  });
});
