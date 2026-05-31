import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextBudget, DEFAULT_CONTEXT_BUDGET } from '../../dist/runtime/ContextBudget.js';

test('ContextBudget.validateActual: drift math matches spec example', () => {
  const b = new ContextBudget(DEFAULT_CONTEXT_BUDGET);
  b.recordPreFlightEstimate(500);
  const r = b.validateActual(600);
  assert.strictEqual(r.estimated, 500);
  assert.strictEqual(r.actual, 600);
  assert.strictEqual(r.drift, 100);
  assert.ok(Math.abs(r.driftPct - 100 / 6) < 0.01);
});

test('ContextBudget.validateActual: warns when drift pct exceeds 20%', () => {
  const b = new ContextBudget(DEFAULT_CONTEXT_BUDGET);
  b.recordPreFlightEstimate(100);
  const originalWarn = console.warn;
  let called = false;
  console.warn = () => {
    called = true;
  };
  try {
    b.validateActual(300);
    assert.ok(called);
  } finally {
    console.warn = originalWarn;
  }
});

test('ContextBudget.validateActual: no warning within 20%', () => {
  const b = new ContextBudget(DEFAULT_CONTEXT_BUDGET);
  b.recordPreFlightEstimate(500);
  const originalWarn = console.warn;
  let called = false;
  console.warn = () => {
    called = true;
  };
  try {
    b.validateActual(600);
    assert.strictEqual(called, false);
  } finally {
    console.warn = originalWarn;
  }
});
