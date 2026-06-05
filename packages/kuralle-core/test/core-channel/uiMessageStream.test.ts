import { describe, expect, it } from 'bun:test';
import { createEventBus, createTurnHandle } from '../../src/events/TurnHandle.js';
import { harnessToUIMessageStream } from '../../src/ai-sdk/uiMessageStream.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

async function* partsSource(parts: HarnessStreamPart[]): AsyncIterable<HarnessStreamPart> {
  for (const part of parts) {
    yield part;
  }
}

type StreamChunk = { type: string; [key: string]: unknown };

async function collectChunks(stream: ReadableStream<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return chunks;
}

function chunksOfType(chunks: StreamChunk[], type: string): StreamChunk[] {
  return chunks.filter((chunk) => chunk.type === type);
}

const FULL_HARNESS_SEQUENCE: HarnessStreamPart[] = [
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hello' },
  { type: 'text-end', id: 't1' },
  { type: 'text-cancel', id: 't2', reason: 'user-abort' },
  { type: 'tool-call', toolName: 'search', args: { q: 'kuralle' }, toolCallId: 'tc-1' },
  { type: 'tool-result', toolName: 'search', result: { hits: 1 }, toolCallId: 'tc-1' },
  { type: 'node-enter', nodeName: 'greet' },
  { type: 'node-exit', nodeName: 'greet' },
  { type: 'flow-enter', flow: 'onboarding' },
  { type: 'flow-transition', from: 'greet', to: 'collect' },
  { type: 'flow-end', flow: 'onboarding', reason: 'completed' },
  { type: 'handoff', targetAgent: 'support', reason: 'escalation' },
  {
    type: 'interactive',
    nodeId: 'pick-plan',
    prompt: 'Choose a plan',
    options: [{ id: 'basic', label: 'Basic' }],
  },
  {
    type: 'safety-blocked',
    moderator: 'guard',
    rationale: 'policy violation',
    userFacingMessage: 'Blocked',
  },
  {
    type: 'pipeline-validation-block',
    rationale: 'invalid output',
    userFacingMessage: 'Try again',
  },
  { type: 'conversation-outcome', outcome: 'resolved' },
  { type: 'interrupted', reason: 'timeout', lastStep: 2 },
  { type: 'paused', waitingFor: 'user-input' },
  { type: 'custom', name: 'metric', data: { ms: 12 } },
  { type: 'turn-end' },
  { type: 'done', sessionId: 'sess-1' },
];

describe('harnessToUIMessageStream', () => {
  it('maps harness parts to native UI message chunks', async () => {
    const stream = harnessToUIMessageStream(partsSource(FULL_HARNESS_SEQUENCE));
    const chunks = await collectChunks(stream as ReadableStream<StreamChunk>);

    expect(chunksOfType(chunks, 'text-start')).toEqual([{ type: 'text-start', id: 't1' }]);
    expect(chunksOfType(chunks, 'text-delta')).toEqual([
      { type: 'text-delta', id: 't1', delta: 'Hello' },
    ]);
    expect(chunksOfType(chunks, 'text-end')).toEqual([
      { type: 'text-end', id: 't1' },
      { type: 'text-end', id: 't2' },
    ]);

    const toolInputs = chunksOfType(chunks, 'tool-input-available');
    expect(toolInputs).toHaveLength(1);
    expect(toolInputs[0]).toMatchObject({
      type: 'tool-input-available',
      toolCallId: 'tc-1',
      toolName: 'search',
      input: { q: 'kuralle' },
    });

    const toolOutputs = chunksOfType(chunks, 'tool-output-available');
    expect(toolOutputs).toHaveLength(1);
    expect(toolOutputs[0]).toMatchObject({
      type: 'tool-output-available',
      toolCallId: 'tc-1',
      output: { hits: 1 },
    });

    const nodeChunks = chunksOfType(chunks, 'data-kuralle-node');
    expect(nodeChunks).toEqual([
      {
        type: 'data-kuralle-node',
        data: { event: 'enter', node: 'greet' },
        transient: true,
      },
      {
        type: 'data-kuralle-node',
        data: { event: 'exit', node: 'greet' },
        transient: true,
      },
    ]);

    const flowChunks = chunksOfType(chunks, 'data-kuralle-flow');
    expect(flowChunks).toEqual([
      {
        type: 'data-kuralle-flow',
        data: { event: 'enter', flow: 'onboarding' },
        transient: true,
      },
      {
        type: 'data-kuralle-flow',
        data: { event: 'transition', from: 'greet', to: 'collect' },
        transient: true,
      },
      {
        type: 'data-kuralle-flow',
        data: { event: 'end', flow: 'onboarding', reason: 'completed' },
        transient: true,
      },
    ]);

    const handoffChunks = chunksOfType(chunks, 'data-kuralle-handoff');
    expect(handoffChunks).toHaveLength(1);
    expect(handoffChunks[0]).toMatchObject({
      type: 'data-kuralle-handoff',
      data: { targetAgent: 'support', reason: 'escalation' },
    });
    expect(handoffChunks[0]?.transient).toBeUndefined();

    const interactiveChunks = chunksOfType(chunks, 'data-kuralle-interactive');
    expect(interactiveChunks).toEqual([
      {
        type: 'data-kuralle-interactive',
        id: 'pick-plan',
        data: {
          nodeId: 'pick-plan',
          prompt: 'Choose a plan',
          options: [{ id: 'basic', label: 'Basic' }],
        },
      },
    ]);

    const safetyChunks = chunksOfType(chunks, 'data-kuralle-safety');
    expect(safetyChunks).toHaveLength(2);
    expect(safetyChunks[0]).toMatchObject({
      type: 'data-kuralle-safety',
      data: {
        kind: 'safety-blocked',
        moderator: 'guard',
        rationale: 'policy violation',
        userFacingMessage: 'Blocked',
      },
    });
    expect(safetyChunks[0]?.transient).toBeUndefined();
    expect(safetyChunks[1]).toMatchObject({
      type: 'data-kuralle-safety',
      data: {
        kind: 'pipeline-validation-block',
        rationale: 'invalid output',
        userFacingMessage: 'Try again',
      },
    });
    expect(safetyChunks[1]?.transient).toBeUndefined();

    const outcomeChunks = chunksOfType(chunks, 'data-kuralle-outcome');
    expect(outcomeChunks).toHaveLength(1);
    expect(outcomeChunks[0]).toMatchObject({
      type: 'data-kuralle-outcome',
      data: { outcome: 'resolved' },
    });
    expect(outcomeChunks[0]?.transient).toBeUndefined();

    const controlChunks = chunksOfType(chunks, 'data-kuralle-control');
    expect(controlChunks).toEqual([
      {
        type: 'data-kuralle-control',
        data: { event: 'interrupted', reason: 'timeout' },
        transient: true,
      },
      {
        type: 'data-kuralle-control',
        data: { event: 'paused', waitingFor: 'user-input' },
        transient: true,
      },
    ]);

    const customChunks = chunksOfType(chunks, 'data-kuralle-custom');
    expect(customChunks).toEqual([
      {
        type: 'data-kuralle-custom',
        data: { name: 'metric', data: { ms: 12 } },
        transient: true,
      },
    ]);

    expect(chunksOfType(chunks, 'turn-end')).toHaveLength(0);
    expect(chunksOfType(chunks, 'done')).toHaveLength(0);
  });

  it('surfaces harness error parts as UI message error chunks', async () => {
    const stream = harnessToUIMessageStream(
      partsSource([
        { type: 'text-start', id: 't1' },
        { type: 'error', error: 'model unavailable' },
      ]),
    );

    const chunks = await collectChunks(stream as ReadableStream<StreamChunk>);
    const errorChunks = chunksOfType(chunks, 'error');
    expect(errorChunks).toHaveLength(1);
    expect(errorChunks[0]).toMatchObject({
      type: 'error',
      errorText: 'model unavailable',
    });
  });

  it('TurnHandle.toUIMessageStreamResponse returns a UI message SSE response', async () => {
    const bus = createEventBus();
    const handle = createTurnHandle({
      bus,
      run: async () => ({ text: 'ok', toolResults: [] }),
    });

    bus.emit({ type: 'text-start', id: 't1' });
    bus.emit({ type: 'text-delta', id: 't1', delta: 'Hi' });
    bus.emit({ type: 'text-end', id: 't1' });
    bus.emit({ type: 'done', sessionId: 'sess-2' });
    bus.close();

    const response = handle.toUIMessageStreamResponse({ sessionId: 'sess-2' });
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = response.body;
    expect(body).not.toBeNull();
    const text = await new Response(body).text();
    expect(text).toContain('"type":"text-start"');
    expect(text).toContain('"type":"text-delta"');
    expect(text).toContain('"delta":"Hi"');
  });
});
