import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { messageFrom, runHostedChat } from '../src/hostedCommands.js';

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

function echoServer() {
  return createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { sessionId: string; message: string };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ sessionId: body.sessionId, response: `echo: ${body.message}` }));
  });
}

function captureStreams() {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    stdoutChunks,
    stderrChunks,
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

describe('messageFrom', () => {
  it('strips --store and its value from the hosted send message', () => {
    expect(messageFrom(['--store', 'runs/x.json', 'check', 'my', 'order'])).toBe('check my order');
  });

  it('strips --summary and its value from the hosted send message', () => {
    expect(messageFrom(['--summary', 'Refund issued.', 'resume', 'please'])).toBe('resume please');
  });

  it('strips every value-taking flag when several are interleaved', () => {
    // The single-flag cases pass even against an implementation that only ever
    // skips index 1. Several flags in sequence are what exercise the
    // "token follows a value-taking flag" rule at every position.
    expect(messageFrom([
      '--session', 'abc-123',
      '--store', 'runs/x.json',
      '--server', 'https://example.test',
      '--token', 'secret-value',
      'where', 'is', 'my', 'order',
    ])).toBe('where is my order');
  });

  it('keeps the first message word after a flag that takes NO value', () => {
    // The inverse failure, and the more damaging one: adding a boolean flag to
    // `consumesValue` would silently eat the first word of the user's message.
    // `--state`, `--reset`, `--trace` and `--local` take no value (see the
    // Options block in cli.ts), so the word after them is message text.
    expect(messageFrom(['--state', 'check', 'my', 'order'])).toBe('check my order');
    expect(messageFrom(['--reset', 'check', 'my', 'order'])).toBe('check my order');
    expect(messageFrom(['--trace', 'check', 'my', 'order'])).toBe('check my order');
    expect(messageFrom(['--local', 'check', 'my', 'order'])).toBe('check my order');
  });
});

describe('runHostedChat --trace warning', () => {
  it('warns on stderr, keeps stdout clean, and still completes the turn when --trace is passed', async () => {
    const server = echoServer();
    const origin = await listen(server);
    const capture = captureStreams();
    try {
      await runHostedChat(['--trace', '--auto', 'hello'], { server: origin, transport: 'http' });
    } finally {
      capture.restore();
      server.close();
    }

    const stderrText = capture.stderrChunks.join('');
    const stdoutText = capture.stdoutChunks.join('');
    expect(stderrText).toContain('--trace');
    expect(stderrText).toContain('hosted');
    expect(stdoutText).not.toContain('--trace has no effect');
    expect(stdoutText).toContain('echo: hello');
  });

  it('does not warn when --trace is absent', async () => {
    const server = echoServer();
    const origin = await listen(server);
    const capture = captureStreams();
    try {
      await runHostedChat(['--auto', 'hello'], { server: origin, transport: 'http' });
    } finally {
      capture.restore();
      server.close();
    }

    expect(capture.stderrChunks.join('')).toBe('');
    expect(capture.stdoutChunks.join('')).toContain('echo: hello');
  });
});
