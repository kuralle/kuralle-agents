import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { createObservabilityHooks } from '../dist/hooks/builtin/observability.js';
import { createHookRunner } from '../dist/hooks/HookRunner.js';

function createSession(overrides = {}) {
  const now = new Date();
  return {
    id: 'sess-test-1',
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-a',
    activeAgentId: 'agent-a',
    agentStates: {},
    handoffHistory: [],
    ...overrides,
  };
}

function createRunContext(session, overrides = {}) {
  return {
    session,
    agentId: session.activeAgentId ?? session.currentAgent,
    stepCount: 2,
    totalTokens: 0,
    handoffStack: [],
    startTime: Date.now(),
    consecutiveErrors: 0,
    toolCallHistory: [],
    ...overrides,
  };
}

test('observability: session trace has turnCount, toolCalls, duration', async () => {
  let exported = null;
  const hooks = createObservabilityHooks({
    exporter: async (trace) => {
      exported = trace;
    },
  });
  const runner = createHookRunner(hooks);
  const session = createSession({ id: 'sess-trace-1' });

  for (let t = 0; t < 3; t++) {
    const ctx = createRunContext(session, { startTime: Date.now() });
    await runner.onStart(ctx);
    await runner.onAgentStart(ctx, ctx.agentId);

    await runner.onToolCall(ctx, {
      toolCallId: `call-${t}`,
      toolName: 'lookup',
      args: { q: 'x' },
      success: true,
      timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 5));
    await runner.onToolResult(ctx, {
      toolCallId: `call-${t}`,
      toolName: 'lookup',
      args: { q: 'x' },
      result: { ok: true },
      success: true,
      timestamp: Date.now(),
    });

    await runner.onEnd(ctx, { success: true });
  }

  await runner.onSessionEnd(session, { success: true });

  assert.ok(exported);
  assert.equal(exported.sessionId, 'sess-trace-1');
  assert.equal(exported.turnCount, 3);
  assert.equal(exported.toolCalls.length, 3);
  assert.ok(exported.durationMs >= 0);
  exported.toolCalls.forEach((tc) => {
    assert.equal(tc.name, 'lookup');
    assert.ok(tc.success);
    assert.ok(tc.durationMs >= 0);
  });
});

test('observability: tool span records start-to-end duration', async () => {
  let exported = null;
  const hooks = createObservabilityHooks({
    exporter: async (trace) => {
      exported = trace;
    },
  });
  const runner = createHookRunner(hooks);
  const session = createSession({ id: 'sess-dur-1' });
  const ctx = createRunContext(session, { startTime: Date.now() });

  await runner.onStart(ctx);
  await runner.onAgentStart(ctx, ctx.agentId);

  await runner.onToolCall(ctx, {
    toolCallId: 'slow',
    toolName: 'slow_tool',
    args: {},
    success: true,
    timestamp: Date.now(),
  });
  await new Promise((r) => setTimeout(r, 30));
  await runner.onToolResult(ctx, {
    toolCallId: 'slow',
    toolName: 'slow_tool',
    args: {},
    result: {},
    success: true,
    timestamp: Date.now(),
  });

  await runner.onEnd(ctx, { success: true });
  await runner.onSessionEnd(session, { success: true });

  assert.ok(exported);
  assert.equal(exported.toolCalls.length, 1);
  assert.ok(exported.toolCalls[0].durationMs >= 25, `expected >=25ms, got ${exported.toolCalls[0].durationMs}`);
});

test('observability: console exporter includes session id and tool names', async () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  try {
    const hooks = createObservabilityHooks({ exporter: 'console' });
    const runner = createHookRunner(hooks);
    const session = createSession({ id: 'sess-console-xyz' });
    const ctx = createRunContext(session, { startTime: Date.now() });

    await runner.onStart(ctx);
    await runner.onAgentStart(ctx, ctx.agentId);
    await runner.onToolCall(ctx, {
      toolCallId: 'c1',
      toolName: 'weather',
      args: {},
      success: true,
      timestamp: Date.now(),
    });
    await runner.onToolResult(ctx, {
      toolCallId: 'c1',
      toolName: 'weather',
      args: {},
      result: {},
      success: true,
      timestamp: Date.now(),
    });
    await runner.onEnd(ctx, { success: true });
    await runner.onSessionEnd(session, { success: true });
  } finally {
    console.log = orig;
  }

  const out = lines.join('\n');
  assert.match(out, /sess-console-xyz/);
  assert.match(out, /weather/);
  assert.match(out, /durationMs=/);
});

test('observability: json exporter writes file', async () => {
  const path = `/tmp/kuralle-obs-test-${Date.now()}.json`;
  const hooks = createObservabilityHooks({ exporter: 'json', outputPath: path });
  const runner = createHookRunner(hooks);
  const session = createSession({ id: 'sess-json' });
  const ctx = createRunContext(session, { startTime: Date.now() });

  await runner.onStart(ctx);
  await runner.onAgentStart(ctx, ctx.agentId);
  await runner.onEnd(ctx, { success: true });
  await runner.onSessionEnd(session, { success: true });

  const raw = await readFile(path, 'utf8');
  const data = JSON.parse(raw);
  assert.equal(data.sessionId, 'sess-json');
  await unlink(path).catch(() => {});
});

test('observability: debounced text-mode trace export (no onSessionEnd)', async () => {
  let exported = null;
  const hooks = createObservabilityHooks({
    exporter: async (trace) => {
      exported = trace;
    },
  });
  const runner = createHookRunner(hooks);
  const session = createSession({ id: 'sess-text-debounce-1' });
  const ctx = createRunContext(session, { startTime: Date.now() });

  await runner.onStart(ctx);
  await runner.onEnd(ctx, { success: true });

  assert.equal(exported, null);
  await sleep(3100);

  assert.ok(exported);
  assert.equal(exported.sessionId, 'sess-text-debounce-1');
  assert.equal(exported.turnCount, 1);
  assert.ok(exported.durationMs >= 0);
});
