import { describe, test, expect } from 'bun:test';
import { FakeRealtimeAudioClient } from '../harness/fake_realtime_client.js';
import type { RealtimeSessionConfig } from '@kuralle-agents/core/realtime';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

const baseConfig: RealtimeSessionConfig = {
  systemInstruction: 'test',
  tools: [],
};

describe('FakeRealtimeAudioClient', () => {
  test('connect sets connected and stores config', async () => {
    const c = new FakeRealtimeAudioClient({ responses: {} });
    await c.connect(baseConfig);
    expect(c.connected).toBe(true);
    expect(c.receivedConfig?.systemInstruction).toBe('test');
  });

  test('injectUserInput emits user transcript, assistant text, and turn-complete', async () => {
    const c = new FakeRealtimeAudioClient({
      responses: { hello: { text: 'Hi there.' } },
    });
    await c.connect(baseConfig);

    const events: string[] = [];
    c.on('transcript', (t, role) => events.push(`transcript:${role}:${t}`));
    c.on('turn-complete', () => events.push('turn-complete'));

    c.injectUserInput('hello');

    expect(events[0]).toBe('transcript:user:hello');
    expect(events).toContain('transcript:assistant:Hi there.');
    expect(events[events.length - 1]).toBe('turn-complete');
  });

  test('substring match is case-insensitive', async () => {
    const c = new FakeRealtimeAudioClient({
      responses: { paris: { text: 'ok' } },
    });
    await c.connect(baseConfig);
    let assistant = '';
    c.on('transcript', (t, role) => {
      if (role === 'assistant') assistant += t;
    });
    c.injectUserInput('Weather in PARIS please');
    expect(assistant).toBe('ok');
  });

  test('unknown input without default uses fallback phrase', async () => {
    const c = new FakeRealtimeAudioClient({ responses: {} });
    await c.connect(baseConfig);
    let assistant = '';
    c.on('transcript', (t, role) => {
      if (role === 'assistant') assistant += t;
    });
    c.injectUserInput('nope nope');
    expect(assistant).toContain("don't understand");
  });

  test('tool-call batch defers turn-complete until sendToolResponse', async () => {
    const c = new FakeRealtimeAudioClient({
      responses: {
        run: {
          toolCalls: [{ name: 'demo_tool', args: { x: 1 } }],
          text: 'Done.',
        },
      },
    });
    await c.connect(baseConfig);

    const seq: string[] = [];
    c.on('transcript', (t, role) => seq.push(`${role}:${t}`));
    c.on('tool-call', (id, name, args) => seq.push(`tool:${name}:${id}`));
    c.on('turn-complete', () => seq.push('tc'));

    c.injectUserInput('run');

    expect(seq).toContain('user:run');
    const toolIdx = seq.findIndex((s) => s.startsWith('tool:demo_tool'));
    expect(toolIdx).toBeGreaterThan(-1);
    expect(seq.includes('tc')).toBe(false);

    c.sendToolResponse([{ id: 't1', name: 'demo_tool', output: { ok: true } }]);
    await flushMicrotasks();

    expect(seq).toContain('assistant:Done.');
    expect(seq[seq.length - 1]).toBe('tc');
  });

  test('multiple tool calls require multiple sendToolResponse before turn-complete', async () => {
    const c = new FakeRealtimeAudioClient({
      responses: {
        multi: {
          toolCalls: [
            { name: 'a', args: {} },
            { name: 'b', args: {} },
          ],
        },
      },
    });
    await c.connect(baseConfig);
    let tc = 0;
    c.on('turn-complete', () => {
      tc += 1;
    });
    c.injectUserInput('multi');
    expect(tc).toBe(0);
    c.sendToolResponse([{ id: '1', name: 'a', output: {} }]);
    expect(tc).toBe(0);
    c.sendToolResponse([{ id: '2', name: 'b', output: {} }]);
    await flushMicrotasks();
    expect(tc).toBe(1);
  });

  test('updateConfig records history and merges config', async () => {
    const c = new FakeRealtimeAudioClient({ responses: {} });
    await c.connect(baseConfig);
    await c.updateConfig({ systemInstruction: 'next' });
    expect(c.configHistory.length).toBe(1);
    expect(c.receivedConfig?.systemInstruction).toBe('next');
  });

  test('requestResponse emits assistant transcript and turn-complete', async () => {
    const c = new FakeRealtimeAudioClient({ responses: {} });
    await c.connect(baseConfig);
    const parts: string[] = [];
    c.on('transcript', (t, role) => parts.push(`${role}:${t}`));
    c.on('turn-complete', () => parts.push('tc'));
    c.requestResponse('go');
    await flushMicrotasks();
    expect(parts.some((p) => p.includes('Continuing.'))).toBe(true);
    expect(parts[parts.length - 1]).toBe('tc');
  });

  test('disconnect emits disconnected', async () => {
    const c = new FakeRealtimeAudioClient({ responses: {} });
    await c.connect(baseConfig);
    let saw = false;
    c.on('disconnected', () => {
      saw = true;
    });
    await c.disconnect();
    expect(saw).toBe(true);
    expect(c.connected).toBe(false);
  });
});
