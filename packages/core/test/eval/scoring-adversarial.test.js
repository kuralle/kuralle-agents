import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreTurn, aggregateScores } from '../../dist/eval/scoring.js';

// ─── scoreTurn edge cases ────────────────────────────────────────────────────

test('scoreTurn: no expectations returns empty checks (turn always passes)', () => {
  const checks = scoreTurn(undefined, 'hello', ['tool_a'], [], 100);
  assert.equal(checks.length, 0);
});

test('scoreTurn: empty expect object returns empty checks', () => {
  const checks = scoreTurn({}, 'hello', [], [], 100);
  assert.equal(checks.length, 0);
});

test('scoreTurn: toolCalls expects tool that was NOT called → fails', () => {
  const checks = scoreTurn(
    { toolCalls: ['search_products'] },
    'Let me search that for you',
    [], // no tools called
    [],
    500,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, false);
  assert.ok(checks[0].detail.includes('Missing tool call'));
});

test('scoreTurn: noToolCalls expects tool NOT called but it WAS → fails', () => {
  const checks = scoreTurn(
    { noToolCalls: ['route_to_tracking'] },
    'Just a product question',
    ['route_to_tracking'], // unexpectedly called
    [],
    200,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, false);
  assert.ok(checks[0].detail.includes('should not have been'));
});

test('scoreTurn: toolCalls AND noToolCalls on same turn — both checked independently', () => {
  const checks = scoreTurn(
    { toolCalls: ['search_products'], noToolCalls: ['route_to_tracking'] },
    'results',
    ['search_products'],
    [],
    200,
  );
  assert.equal(checks.length, 2);
  assert.equal(checks[0].passed, true); // search_products was called
  assert.equal(checks[1].passed, true); // route_to_tracking was not called
});

test('scoreTurn: flowTransition expected but none occurred → fails', () => {
  const checks = scoreTurn(
    { flowTransition: { from: 'hub', to: 'collect_tracking' } },
    'routing',
    ['route_to_tracking'],
    [], // no transitions captured
    300,
  );
  const transCheck = checks.find(c => c.name === 'transition');
  assert.ok(transCheck);
  assert.equal(transCheck.passed, false);
  assert.ok(transCheck.detail.includes('(none)'));
});

test('scoreTurn: flowTransition wrong direction → fails', () => {
  const checks = scoreTurn(
    { flowTransition: { from: 'hub', to: 'collect_tracking' } },
    'response',
    [],
    [{ from: 'collect_tracking', to: 'hub' }], // reverse direction
    200,
  );
  const transCheck = checks.find(c => c.name === 'transition');
  assert.ok(transCheck);
  assert.equal(transCheck.passed, false);
});

test('scoreTurn: responseContains with empty response → fails', () => {
  const checks = scoreTurn(
    { responseContains: ['hello'] },
    '', // empty response
    [],
    [],
    100,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, false);
});

test('scoreTurn: responseNotContains with matching substring → fails', () => {
  const checks = scoreTurn(
    { responseNotContains: ['error', 'failed'] },
    'There was an error processing your request',
    [],
    [],
    100,
  );
  const errorCheck = checks.find(c => c.name === 'notContains:error');
  assert.ok(errorCheck);
  assert.equal(errorCheck.passed, false);
});

test('scoreTurn: maxLatencyMs exactly at boundary → passes (<=)', () => {
  const checks = scoreTurn(
    { maxLatencyMs: 500 },
    'fast',
    [],
    [],
    500, // exactly at limit
  );
  assert.equal(checks[0].passed, true);
});

test('scoreTurn: maxLatencyMs exceeded by 1ms → fails', () => {
  const checks = scoreTurn(
    { maxLatencyMs: 500 },
    'slow',
    [],
    [],
    501,
  );
  assert.equal(checks[0].passed, false);
});

test('scoreTurn: extractionFields with no snapshot → fails with explanation', () => {
  const checks = scoreTurn(
    { extractionFields: { name: 'Alice' } },
    'response',
    [],
    [],
    100,
    undefined, // no snapshot
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].passed, false);
  assert.ok(checks[0].detail.includes('no flow extraction snapshot'));
});

test('scoreTurn: extractionFields partial match — some pass, some fail', () => {
  const checks = scoreTurn(
    { extractionFields: { name: 'Alice', phone: '555-1234', email: 'alice@test.com' } },
    'response',
    [],
    [],
    100,
    { name: 'Alice', phone: '555-1234' }, // email missing
  );
  const nameCheck = checks.find(c => c.name === 'extraction:name');
  const phoneCheck = checks.find(c => c.name === 'extraction:phone');
  const emailCheck = checks.find(c => c.name === 'extraction:email');
  assert.ok(nameCheck?.passed);
  assert.ok(phoneCheck?.passed);
  assert.ok(!emailCheck?.passed);
});

test('scoreTurn: extractionFields with nested object comparison', () => {
  const checks = scoreTurn(
    { extractionFields: { slots: ['9:00 AM', '2:00 PM'] } },
    'response',
    [],
    [],
    100,
    { slots: ['9:00 AM', '2:00 PM'] },
  );
  assert.equal(checks[0].passed, true);
});

test('scoreTurn: extractionFields with null expected vs undefined actual → fails', () => {
  const checks = scoreTurn(
    { extractionFields: { name: null } },
    'response',
    [],
    [],
    100,
    { name: undefined }, // undefined !== null
  );
  // JSON.stringify(undefined) vs JSON.stringify(null) — both become different
  // This tests the valuesEqual function
  assert.equal(checks[0].passed, false);
});

// ─── aggregateScores edge cases ──────────────────────────────────────────────

test('aggregateScores: empty turns → passRate 1, avg 0', () => {
  const score = aggregateScores('empty', 'text', []);
  assert.equal(score.passed, true); // no failures = passed
  assert.equal(score.aggregate.passRate, 1);
  assert.equal(score.aggregate.totalTurns, 0);
  assert.equal(score.aggregate.avgLatencyMs, 0);
});

test('aggregateScores: all turns fail → passRate 0, passed false', () => {
  const turns = [
    { turnIndex: 0, input: 'a', response: 'b', passed: false, checks: [{ name: 'x', passed: false, detail: '' }], latencyMs: 100, toolsCalled: [], flowTransitions: [] },
    { turnIndex: 1, input: 'c', response: 'd', passed: false, checks: [{ name: 'y', passed: false, detail: '' }], latencyMs: 200, toolsCalled: [], flowTransitions: [] },
  ];
  const score = aggregateScores('fail', 'text', turns);
  assert.equal(score.passed, false);
  assert.equal(score.aggregate.passRate, 0);
  assert.equal(score.aggregate.failedTurns, 2);
});

test('aggregateScores: toolCallAccuracy with mixed results', () => {
  const turns = [
    { turnIndex: 0, input: '', response: '', passed: true, checks: [
      { name: 'tool:search', passed: true, detail: '' },
      { name: 'tool:lookup', passed: false, detail: '' },
    ], latencyMs: 100, toolsCalled: ['search'], flowTransitions: [] },
  ];
  const score = aggregateScores('mixed', 'text', turns);
  assert.equal(score.aggregate.toolCallAccuracy, 0.5); // 1 of 2 passed
});

test('aggregateScores: extractionAccuracy with no extraction checks → defaults to 1', () => {
  const turns = [
    { turnIndex: 0, input: '', response: '', passed: true, checks: [
      { name: 'tool:search', passed: true, detail: '' },
    ], latencyMs: 100, toolsCalled: ['search'], flowTransitions: [] },
  ];
  const score = aggregateScores('no-extraction', 'text', turns);
  assert.equal(score.aggregate.extractionAccuracy, 1); // no extraction checks → 100%
});

test('aggregateScores: latency percentiles with single turn', () => {
  const turns = [
    { turnIndex: 0, input: '', response: '', passed: true, checks: [], latencyMs: 500, toolsCalled: [], flowTransitions: [] },
  ];
  const score = aggregateScores('single', 'text', turns);
  assert.equal(score.aggregate.p50LatencyMs, 500);
  assert.equal(score.aggregate.p95LatencyMs, 500);
  assert.equal(score.aggregate.avgLatencyMs, 500);
});

test('aggregateScores: noToolCalls checks count toward toolCallAccuracy', () => {
  const turns = [
    { turnIndex: 0, input: '', response: '', passed: true, checks: [
      { name: 'no-tool:route_to_tracking', passed: true, detail: '' },
    ], latencyMs: 100, toolsCalled: [], flowTransitions: [] },
  ];
  const score = aggregateScores('no-tool', 'text', turns);
  assert.equal(score.aggregate.toolCallAccuracy, 1); // no-tool: prefix counts
});

// ─── Turn pass/fail logic ────────────────────────────────────────────────────

test('turn with no checks (no expect) is marked as passed', () => {
  // In EvalRunner line 69: checks.length === 0 ? true : checks.every(c => c.passed)
  // A turn with no expectations should pass, not be undefined
  const checks = scoreTurn(undefined, 'hello', [], [], 100);
  const passed = checks.length === 0 ? true : checks.every(c => c.passed);
  assert.equal(passed, true);
});

test('turn with one failing check out of many → entire turn fails', () => {
  const checks = scoreTurn(
    {
      toolCalls: ['search_products'],
      responseContains: ['Sony'],
      maxLatencyMs: 5000,
    },
    'We have the Sony WH-1000XM5',
    ['search_products'],
    [],
    6000, // exceeds latency
  );
  const allPassed = checks.every(c => c.passed);
  assert.equal(allPassed, false); // latency fails, so turn fails
  // But tool and response checks passed
  assert.equal(checks.find(c => c.name === 'tool:search_products')?.passed, true);
  assert.equal(checks.find(c => c.name === 'contains:Sony')?.passed, true);
  assert.equal(checks.find(c => c.name === 'latency')?.passed, false);
});
