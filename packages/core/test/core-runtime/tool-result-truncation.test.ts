import { describe, expect, it } from 'bun:test';
import { CoreToolExecutor } from '../../src/tools/effect/ToolExecutor.js';
import { dispatchModelToolCalls, toolResultMessage } from '../../src/runtime/channels/executeModelTool.js';
import {
  DEFAULT_MAX_TOOL_RESULT_TOKENS,
  truncateForTranscript,
  type TruncatedToolResult,
} from '../../src/runtime/channels/truncateToolResult.js';
import { estimateTokenCount } from '../../src/runtime/ContextBudget.js';
import { buildCtx, setupDurableHarness } from '../core-durable/helpers.js';

function isTruncated(value: unknown): value is TruncatedToolResult {
  return typeof value === 'object' && value !== null && '__truncated' in value;
}

describe('truncateForTranscript', () => {
  it('returns a value under budget unchanged, by reference', () => {
    const original = { ok: true, data: 'small payload' };
    expect(truncateForTranscript(original, 8_000)).toBe(original);
    // Sanity: the default ceiling is generous enough that ordinary tool results never trip it.
    expect(truncateForTranscript(original)).toBe(original);
    expect(DEFAULT_MAX_TOOL_RESULT_TOKENS).toBe(8_000);
  });

  it('truncates the middle of an over-budget value, keeping both head and tail', () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `line-${i}:${'x'.repeat(20)}`);
    const big = lines.join('\n') + '\nFINAL-RECORD-END';
    const maxTokens = 200;
    expect(estimateTokenCount(big)).toBeGreaterThan(maxTokens);

    const result = truncateForTranscript(big, maxTokens);
    if (!isTruncated(result)) throw new Error('expected a TruncatedToolResult');

    expect(result.value).toContain('line-0:');
    expect(result.value).toContain('FINAL-RECORD-END');
    expect(result.__truncated.note).toContain('truncated');
    expect(result.__truncated.originalTokens).toBe(estimateTokenCount(big));
    expect(result.__truncated.shownTokens).toBeLessThanOrEqual(maxTokens);
    expect(estimateTokenCount(result.value)).toBe(result.__truncated.shownTokens);
  });

  it('never splits a multi-byte UTF-8 sequence at either truncation seam', () => {
    // Repeat CJK + emoji (surrogate-pair) characters so a naive char-index slice would land
    // mid-sequence somewhere in a payload this long, regardless of the exact budget math.
    const unit = '你好世界😀🚀日本語テスト';
    const big = unit.repeat(2_000) + 'TAIL-MARKER-🎉';
    const maxTokens = 150;

    const result = truncateForTranscript(big, maxTokens);
    if (!isTruncated(result)) throw new Error('expected a TruncatedToolResult');

    // A split surrogate pair or a cut multi-byte UTF-8 sequence decodes to U+FFFD.
    expect(result.value).not.toContain('�');
    // Re-encoding must round-trip without loss — proof the seams sit on valid boundaries.
    const reEncoded = new TextEncoder().encode(result.value);
    const reDecoded = new TextDecoder('utf-8', { fatal: true }).decode(reEncoded);
    expect(reDecoded).toBe(result.value);
    expect(result.value).toContain('TAIL-MARKER');
  });
});

describe('toolResultMessage caps at the transcript boundary, not the journal', () => {
  it('keeps the full result in the durable journal while the transcript message is bounded', async () => {
    const harness = await setupDurableHarness('trunc-sess', 'trunc-run');
    const bigResult = { rows: Array.from({ length: 3_000 }, (_, i) => ({ id: i, note: 'row payload data' })) };
    const tools = {
      big_query: {
        name: 'big_query',
        description: 'Returns a large payload',
        execute: async () => bigResult,
      },
    };

    const ctx = await buildCtx({ ...harness, toolExecutor: new CoreToolExecutor({ tools }) });
    const call = { toolName: 'big_query', input: {}, toolCallId: 'c1' };

    const delivered: unknown[] = [];
    await dispatchModelToolCalls(ctx, [call], tools, ({ outcome }) => delivered.push(outcome.result));

    // ctx.tool()'s caller-facing result is the full, untruncated value.
    expect(delivered).toEqual([bigResult]);

    // The durable journal holds the full value too — replay fidelity must not be capped.
    const steps = await harness.runStore.getSteps('trunc-run');
    const step = steps.find((s) => s.name === 'big_query');
    expect(step?.result).toEqual(bigResult);

    // Only the transcript-facing message is bounded.
    const maxTokens = 50;
    const message = toolResultMessage(call, delivered[0], maxTokens);
    const value = message.content[0].output.value as unknown;
    expect(isTruncated(value)).toBe(true);
    if (isTruncated(value)) {
      expect(estimateTokenCount(JSON.stringify(bigResult))).toBeGreaterThan(maxTokens);
      expect(value.__truncated.shownTokens).toBeLessThanOrEqual(maxTokens);
    }
  });

  it('leaves a small result unbounded in the transcript message', async () => {
    const call = { toolName: 'small', input: {}, toolCallId: 'c2' };
    const message = toolResultMessage(call, { ok: true }, 8_000);
    expect(message.content[0].output.value).toEqual({ ok: true });
  });
});
