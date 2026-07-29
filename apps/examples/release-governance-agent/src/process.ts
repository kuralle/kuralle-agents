import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 200_000;
const TRUNCATION_MARKER = `\n[output truncated at ${OUTPUT_LIMIT} characters]`;

interface OutputBuffer {
  value: string;
  truncated: boolean;
}

function append(buffer: OutputBuffer, chunk: string): void {
  if (buffer.truncated) return;
  const remaining = OUTPUT_LIMIT - TRUNCATION_MARKER.length - buffer.value.length;
  if (chunk.length <= remaining) {
    buffer.value += chunk;
    return;
  }
  buffer.value += chunk.slice(0, Math.max(0, remaining));
  buffer.truncated = true;
}

function output(buffer: OutputBuffer): string {
  return buffer.truncated ? `${buffer.value}${TRUNCATION_MARKER}` : buffer.value;
}

export async function runProcess(
  command: [string, ...string[]],
  options: { cwd: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const [executable, ...args] = command;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: OutputBuffer = { value: '', truncated: false };
    const stderr: OutputBuffer = { value: '', truncated: false };
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, options.timeoutMs ?? 20 * 60_000);
    timer.unref();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { append(stdout, chunk); });
    child.stderr.on('data', (chunk: string) => { append(stderr, chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) append(stderr, `\nProcess terminated by ${signal}.`);
      resolve({
        exitCode: code ?? 1,
        stdout: output(stdout),
        stderr: output(stderr),
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}

export async function git(repoRoot: string, ...args: string[]): Promise<string> {
  const result = await runProcess(['git', ...args], { cwd: repoRoot, timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
