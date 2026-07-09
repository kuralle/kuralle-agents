import type { Shell, ShellExecOptions, ShellResult } from '@kuralle-agents/core';

export interface BashLike {
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getCwd(): string;
  fs: unknown;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function composeSignals(
  timeoutMs?: number,
  signal?: AbortSignal,
): AbortSignal | undefined {
  if (timeoutMs === undefined && signal === undefined) return undefined;
  if (timeoutMs === undefined) return signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  timeoutSignal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted || timeoutSignal.aborted) onAbort();
  return controller.signal;
}

export function bashShell(bash: BashLike): Shell {
  return {
    cwd: bash.getCwd(),
    async exec(command: string, options?: ShellExecOptions): Promise<ShellResult> {
      if (options?.signal?.aborted) throw abortError();

      const mergedSignal = composeSignals(options?.timeoutMs, options?.signal);
      if (mergedSignal?.aborted) throw abortError();

      const result = await bash.exec(command, {
        cwd: options?.cwd,
        env: options?.env,
        signal: mergedSignal,
      });

      if (options?.signal?.aborted) throw abortError();

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}