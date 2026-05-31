/**
 * Tests for the context-overflow recovery layer.
 *
 * - isContextOverflowError: classifier for provider context-overflow
 *   errors (OpenAI, Anthropic, generic 400).
 * - recoverFromContextOverflow: strip the failed turn from session.messages,
 *   trigger force-compact, return updated messages.
 *
 * Industry references for the classifier patterns:
 *   - OpenAI: code='context_length_exceeded', or message contains
 *     'maximum context length'/'context_length_exceeded'/'reduce the length'.
 *   - Anthropic: status 400, message contains 'prompt is too long'.
 *   - Generic: status 400, message matches /context.{0,20}(window|length|tokens)/i.
 *
 * See also: Flue's `isContextOverflow` (packages/runtime/src/compaction.ts);
 * pi-agent-core ships an equivalent classifier as a primitive.
 */
import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { createMockSession } from '@kuralle-agents/core/testing';
import type { Session } from '../src/types/index.ts';
import {
  isContextOverflowError,
  recoverFromContextOverflow,
} from '../src/runtime/contextOverflow.ts';

/** APICallError-like shape used by provider overflow classifiers in tests. */
class MockAPICallError extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
  url?: string;

  constructor(
    message: string,
    init: { code?: string; status?: number; statusCode?: number; url?: string; name?: string } = {},
  ) {
    super(message);
    if (init.name) this.name = init.name;
    this.code = init.code;
    this.status = init.status;
    this.statusCode = init.statusCode ?? init.status;
    this.url = init.url;
  }
}

function makeProviderError(
  message: string,
  init: { code?: string; status?: number; statusCode?: number; url?: string; name?: string } = {},
): MockAPICallError {
  return new MockAPICallError(message, init);
}

function makeOpenAIError(opts: { code?: string; message?: string; status?: number } = {}) {
  const status = opts.status ?? 400;
  return makeProviderError(opts.message ?? 'context_length_exceeded', {
    code: opts.code,
    status,
    statusCode: status,
  });
}

function makeAnthropicError(opts: { message?: string; status?: number } = {}) {
  const status = opts.status ?? 400;
  return makeProviderError(opts.message ?? 'prompt is too long: 250000 tokens > 200000', {
    status,
    statusCode: status,
    name: 'AI_APICallError',
  });
}

function makeSession(messages: ModelMessage[] = []): Session {
  return createMockSession({
    id: 's-1',
    currentAgent: 'a',
    messages,
  });
}

function userTextContent(msg: ModelMessage | undefined): string | undefined {
  if (!msg || msg.role !== 'user') return undefined;
  return typeof msg.content === 'string' ? msg.content : undefined;
}

describe('isContextOverflowError', () => {
  it('matches OpenAI code=context_length_exceeded', () => {
    expect(isContextOverflowError(makeOpenAIError({ code: 'context_length_exceeded' }))).toBe(true);
  });

  it('matches OpenAI message "maximum context length"', () => {
    const err = makeOpenAIError({
      message: 'This model\'s maximum context length is 128000 tokens.',
    });
    expect(isContextOverflowError(err)).toBe(true);
  });

  it('matches Anthropic "prompt is too long"', () => {
    expect(isContextOverflowError(makeAnthropicError())).toBe(true);
  });

  it('matches generic /context.{0,20}(window|length|tokens)/i + status 400', () => {
    expect(
      isContextOverflowError(
        makeProviderError('Request exceeded context window of 32000', { status: 400, statusCode: 400 }),
      ),
    ).toBe(true);
  });

  it('matches "reduce the length of the messages"', () => {
    expect(
      isContextOverflowError(
        makeProviderError('Please reduce the length of the messages.', { status: 400, statusCode: 400 }),
      ),
    ).toBe(true);
  });

  it('does NOT match unrelated 400 errors', () => {
    expect(
      isContextOverflowError(
        makeProviderError('Invalid request: bad parameter', { status: 400, statusCode: 400 }),
      ),
    ).toBe(false);
  });

  it('does NOT match 401/403/500 even with matching message', () => {
    expect(
      isContextOverflowError(
        makeProviderError('context length error', { status: 500, statusCode: 500 }),
      ),
    ).toBe(false);
  });

  it('returns false for null/undefined/non-error inputs', () => {
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError('a string')).toBe(false);
    expect(isContextOverflowError({})).toBe(false);
  });

  it('handles AI SDK nested error shape (err.responseHeaders + err.url + status)', () => {
    expect(
      isContextOverflowError(
        makeProviderError('AI_APICallError: context_length_exceeded', {
          statusCode: 400,
          url: 'https://api.openai.com/v1/chat/completions',
        }),
      ),
    ).toBe(true);
  });
});

describe('recoverFromContextOverflow', () => {
  it('preserves the user message — strips only trailing partial work', async () => {
    // Turn 3 — overflowing turn: user spoke, assistant never produced
    // anything. The user message MUST survive so retry can answer it.
    const session = makeSession([
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'reply 2' },
      { role: 'user', content: 'turn 3 (overflowed)' },
    ]);

    const result = await recoverFromContextOverflow(session);

    // Nothing trailing → nothing stripped. The user's question survives.
    expect(result.stripped).toBe(false);
    expect(result.strippedCount).toBe(0);
    expect(session.messages.length).toBe(5);
    expect(userTextContent(session.messages[4])).toBe('turn 3 (overflowed)');
  });

  it('strips partial assistant + tool messages that followed an in-flight user turn', async () => {
    const session = makeSession([
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      // Turn 2 — user spoke, assistant started, tool called, then overflow
      { role: 'user', content: 'turn 2 (overflowed)' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'x', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'x', output: { type: 'text', value: 'big result' } }] },
    ]);

    const result = await recoverFromContextOverflow(session);

    expect(result.stripped).toBe(true);
    expect(session.messages.length).toBe(3);
    expect(userTextContent(session.messages[2])).toBe('turn 2 (overflowed)');
    expect(result.strippedCount).toBe(2);
  });

  it('reports stripped:false when there is no user message at all', async () => {
    const session = makeSession([{ role: 'system', content: 'sys' }]);
    const result = await recoverFromContextOverflow(session);
    expect(result.stripped).toBe(false);
    expect(result.strippedCount).toBe(0);
    expect(session.messages.length).toBe(1);
  });

  it('reports stripped:false on empty session', async () => {
    const session = makeSession([]);
    const result = await recoverFromContextOverflow(session);
    expect(result.stripped).toBe(false);
    expect(session.messages.length).toBe(0);
  });
});
