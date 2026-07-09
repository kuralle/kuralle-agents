import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_BUDGET,
  computeMessageHistoryBudget,
  truncateToTokenBudget,
  formatMemoryWithBudget,
  estimateTokenCount,
} from '../../dist/runtime/ContextBudget.js';

// ===== ContextBudgetConfig =====

test('ContextBudgetConfig: defaults have expected values', () => {
  assert.strictEqual(DEFAULT_CONTEXT_BUDGET.modelContextWindow, 128_000);
  assert.strictEqual(DEFAULT_CONTEXT_BUDGET.responseReserve, 4_096);
  assert.strictEqual(DEFAULT_CONTEXT_BUDGET.maxAutoRetrieveTokens, 4_000);
  assert.strictEqual(DEFAULT_CONTEXT_BUDGET.maxWorkingMemoryTokens, 2_000);
  assert.strictEqual(DEFAULT_CONTEXT_BUDGET.maxExtractionTokens, 2_000);
  assert.strictEqual(DEFAULT_CONTEXT_BUDGET.maxLongTermMemoryTokens, 2_000);
  assert.strictEqual(DEFAULT_CONTEXT_BUDGET.maxBasePromptTokens, 0);
});

test('ContextBudgetConfig: partial merges work correctly', () => {
  const custom = { ...DEFAULT_CONTEXT_BUDGET, modelContextWindow: 200_000 };
  assert.strictEqual(custom.modelContextWindow, 200_000);
  assert.strictEqual(custom.responseReserve, 4_096); // preserved from default
});

// ===== computeMessageHistoryBudget =====

test('computeMessageHistoryBudget: correct residual calculation', () => {
  const budget = computeMessageHistoryBudget(DEFAULT_CONTEXT_BUDGET, 2000, 500);
  // 128000 - 4096 - (2000 + 4000 + 2000 + 2000 + 2000 + 500) = 111404
  assert.strictEqual(budget, 111_404);
});

test('computeMessageHistoryBudget: floor at 1000 with console.warn', () => {
  const originalWarn = console.warn;
  let warnCalls = 0;
  console.warn = () => {
    warnCalls += 1;
  };
  try {
    const tinyConfig = {
      ...DEFAULT_CONTEXT_BUDGET,
      modelContextWindow: 5_000,
      responseReserve: 1_000,
    };
    const result = computeMessageHistoryBudget(tinyConfig, 2000, 500);
    // 5000 - 1000 - (2000 + 4000 + 2000 + 2000 + 2000 + 500) = -8500
    assert.strictEqual(result, 1000);
    assert.ok(warnCalls >= 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('computeMessageHistoryBudget: zero-valued sections', () => {
  const config = {
    ...DEFAULT_CONTEXT_BUDGET,
    maxAutoRetrieveTokens: 0,
    maxWorkingMemoryTokens: 0,
    maxExtractionTokens: 0,
    maxLongTermMemoryTokens: 0,
  };
  const budget = computeMessageHistoryBudget(config, 2000, 500);
  // 128000 - 4096 - (2000 + 0 + 0 + 0 + 0 + 500) = 121404
  assert.strictEqual(budget, 121_404);
});

// ===== truncateToTokenBudget =====

test('truncateToTokenBudget: passthrough when within budget', () => {
  const text = 'Hello world';
  const result = truncateToTokenBudget(text, 100);
  assert.strictEqual(result, text);
});

test('truncateToTokenBudget: truncate at sentence boundary', () => {
  // Create a text with clear sentences
  const sentence1 = 'First sentence here. ';
  const sentence2 = 'Second sentence here. ';
  const sentence3 = 'Third sentence here.';
  const text = sentence1 + sentence2 + sentence3;

  // Budget that fits first two sentences but not third
  const tokens = estimateTokenCount(sentence1 + sentence2) + 1;
  const result = truncateToTokenBudget(text, tokens);
  assert.ok(result.includes('[truncated]'), 'Should include truncated marker');
  assert.ok(result.includes('Second sentence here.'), 'Should include up to second sentence');
});

test('truncateToTokenBudget: fallback when no sentence boundaries', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(100); // No periods
  const result = truncateToTokenBudget(text, 10);
  assert.ok(result.includes('[truncated]'), 'Should include truncated marker');
  assert.ok(result.length < text.length, 'Should be shorter');
});

test('truncateToTokenBudget: zero budget returns empty', () => {
  assert.strictEqual(truncateToTokenBudget('any text', 0), '');
});

// ===== formatMemoryWithBudget =====

test('formatMemoryWithBudget: passthrough when within budget', () => {
  const memory = { key1: 'value1', key2: 'value2' };
  const result = formatMemoryWithBudget(memory, 10000);
  assert.ok(result.includes('## Known Information'));
  assert.ok(result.includes('key1'));
  assert.ok(result.includes('key2'));
  assert.ok(!result.includes('omitted'));
});

test('formatMemoryWithBudget: drop oldest entries when over budget', () => {
  const memory = {
    first: 'a'.repeat(100),
    second: 'b'.repeat(100),
    third: 'c'.repeat(100),
  };
  // Set a budget that allows header + one entry
  const result = formatMemoryWithBudget(memory, 40);
  assert.ok(result.includes('## Known Information'));
  assert.ok(result.includes('omitted'), 'Should show omitted count');
});

test('formatMemoryWithBudget: atomic entries — no partial entries', () => {
  const memory = { short: 'hi', long: 'x'.repeat(1000) };
  const result = formatMemoryWithBudget(memory, 50);
  // The long entry should either be fully included or fully excluded
  if (result.includes('long')) {
    assert.ok(result.includes('x'.repeat(1000)), 'If included, should be complete');
  }
});

test('formatMemoryWithBudget: empty input', () => {
  assert.strictEqual(formatMemoryWithBudget({}, 1000), '');
});

test('formatMemoryWithBudget: zero budget returns empty', () => {
  assert.strictEqual(formatMemoryWithBudget({ key: 'value' }, 0), '');
});

test('formatMemoryWithBudget: allowlist filters entries', () => {
  const memory = { allowed: 'yes', blocked: 'no' };
  const result = formatMemoryWithBudget(memory, 10000, ['allowed']);
  assert.ok(result.includes('allowed'));
  assert.ok(!result.includes('blocked'));
});
