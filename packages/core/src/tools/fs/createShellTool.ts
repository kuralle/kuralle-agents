import { z } from 'zod';
import { defineTool } from '../effect/defineTool.js';
import type { AnyTool } from '../../types/effectTool.js';
import type { Shell } from '../../types/shell.js';
import { MAX_SHELL_OUTPUT_BYTES } from './caps.js';

export interface CreateShellToolOptions {
  shell: Shell;
  timeoutMs?: number;
}

const bashInput = z.object({
  command: z.string(),
  timeout: z.number().optional(),
});

const TIMEOUT_EXIT_CODE = 124;

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out');
}

function capShellOutput(
  stdout: string,
  stderr: string,
): { stdout: string; stderr: string } {
  const combined = stdout.length + stderr.length;
  if (combined <= MAX_SHELL_OUTPUT_BYTES) {
    return { stdout, stderr };
  }

  const note = `\n[kuralle] output truncated at ${MAX_SHELL_OUTPUT_BYTES} bytes`;
  const budget = MAX_SHELL_OUTPUT_BYTES - note.length;
  if (budget <= 0) {
    return { stdout: '', stderr: note.trim() };
  }

  if (stdout.length >= budget) {
    return { stdout: stdout.slice(0, budget), stderr: note.trim() };
  }

  const stderrBudget = budget - stdout.length;
  return {
    stdout,
    stderr: `${stderr.slice(0, stderrBudget)}${note}`,
  };
}

export function createShellTool(opts: CreateShellToolOptions): AnyTool {
  const defaultTimeoutMs = opts.timeoutMs;

  return defineTool({
    name: 'bash',
    description:
      'Run a shell command in the agent workspace. Returns stdout, stderr, exitCode. Output is truncated when large.',
    replay: false,
    input: bashInput,
    execute: async (args, ctx) => {
      const timeoutMs =
        args.timeout !== undefined ? args.timeout * 1000 : defaultTimeoutMs;

      if (ctx?.abortSignal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        result = await opts.shell.exec(args.command, {
          timeoutMs,
          signal: ctx?.abortSignal,
        });
      } catch (error) {
        if (ctx?.abortSignal?.aborted) {
          throw error;
        }
        if (isTimeoutError(error)) {
          const seconds =
            timeoutMs !== undefined ? Math.round(timeoutMs / 1000) : args.timeout ?? 0;
          return {
            op: 'bash' as const,
            ok: false,
            stdout: '',
            stderr: `[kuralle] command timed out after ${seconds}s`,
            exitCode: TIMEOUT_EXIT_CODE,
          };
        }
        throw error;
      }

      if (result.exitCode === TIMEOUT_EXIT_CODE) {
        const seconds =
          timeoutMs !== undefined ? Math.round(timeoutMs / 1000) : args.timeout ?? 0;
        return {
          op: 'bash' as const,
          ok: false,
          stdout: result.stdout,
          stderr:
            result.stderr ||
            `[kuralle] command timed out after ${seconds}s`,
          exitCode: TIMEOUT_EXIT_CODE,
        };
      }

      const capped = capShellOutput(result.stdout, result.stderr);
      return {
        op: 'bash' as const,
        ok: result.exitCode === 0,
        stdout: capped.stdout,
        stderr: capped.stderr,
        exitCode: result.exitCode,
      };
    },
  });
}