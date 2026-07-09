import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { TwilioTextOutput } from '../src/text_output.js';

initializeLogger({ pretty: false, level: 'error' });

describe('TwilioTextOutput', () => {
  it('emits incremental mark names', async () => {
    const marks: string[] = [];
    const output = new TwilioTextOutput();
    output.setSendCallback((mark) => marks.push(mark));

    await output.output.captureText('hello');
    await output.output.captureText('world');

    expect(marks).toEqual(['agent_response_1', 'agent_response_2']);
  });

  it('flush does not emit an additional mark', async () => {
    const marks: string[] = [];
    const output = new TwilioTextOutput();
    output.setSendCallback((mark) => marks.push(mark));

    await output.output.captureText('hello');
    output.output.flush();

    expect(marks).toEqual(['agent_response_1']);
  });

  it('close prevents further mark emission', async () => {
    const marks: string[] = [];
    const output = new TwilioTextOutput();
    output.setSendCallback((mark) => marks.push(mark));

    await output.output.close();
    await output.output.captureText('ignored');

    expect(marks.length).toBe(0);
  });
});
