import type { Shell, ShellExecOptions, ShellResult } from '@kuralle-agents/core';

export interface CloudflareSandboxStub {
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    },
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode?: number;
  }>;
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export function cloudflareShell(
  stub: CloudflareSandboxStub,
  opts?: { cwd?: string },
): Shell {
  const defaultCwd = opts?.cwd;

  return {
    cwd: defaultCwd,
    async exec(command: string, options?: ShellExecOptions): Promise<ShellResult> {
      if (options?.signal?.aborted) throw abortError();

      const timeout =
        options?.timeoutMs !== undefined
          ? Math.ceil(options.timeoutMs / 1000)
          : undefined;

      const result = await stub.exec(command, {
        cwd: options?.cwd ?? defaultCwd,
        env: options?.env,
        timeout,
      });

      if (options?.signal?.aborted) throw abortError();

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
      };
    },
  };
}