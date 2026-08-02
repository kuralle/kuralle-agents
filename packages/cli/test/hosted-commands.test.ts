import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { runHostedChat } from '../src/hostedCommands.js';

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
