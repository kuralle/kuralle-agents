import { spawn, spawnSync } from 'node:child_process';
import type { Shell, ShellExecOptions, ShellResult } from '@kuralle-agents/core';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

const DEFAULT_LOCAL_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'HOSTNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
] as const;

let resolvedShell: string | true | undefined;

function resolveShell(): string | true {
  if (resolvedShell === undefined) {
    if (process.platform === 'win32') {
      resolvedShell = true;
    } else {
      const probe = spawnSync('bash', ['-c', 'command -v bash'], {
        encoding: 'utf8',
      });
      const found = probe.status === 0 ? probe.stdout.trim() : '';
      resolvedShell = found.startsWith('/') ? found : true;
    }
  }
  return resolvedShell;
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

function resolveBaseEnv(
  userEnv?: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const key of DEFAULT_LOCAL_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) base[key] = value;
  }
  if (!userEnv) return base;
  for (const [key, value] of Object.entries(userEnv)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

function execShell(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: resolveShell(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killTree = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // Already gone.
        }
      }
    };

    const onAbort = (): void => {
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };

    const settle = (result: ShellResult): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    }

    const onData = (chunk: string, target: 'stdout' | 'stderr'): void => {
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (!truncated && stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        truncated = true;
        killTree('SIGTERM');
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onData(chunk, 'stdout'));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => onData(chunk, 'stderr'));

    child.once('error', (err) => {
      killTree('SIGTERM');
      settle({
        stdout,
        stderr: stderr || String(err.message ?? err),
        exitCode: 1,
      });
    });

    child.once('close', (code) => {
      if (truncated) {
        settle({
          stdout,
          stderr: `${stderr}\n[kuralle] local exec output exceeded ${MAX_OUTPUT_BYTES} bytes; process tree killed`,
          exitCode: 1,
        });
        return;
      }
      settle({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export function nodeShell(opts?: {
  cwd?: string;
  env?: Record<string, string>;
}): Shell {
  const cwd = opts?.cwd ?? process.cwd();
  const baseEnv = resolveBaseEnv(opts?.env);

  return {
    cwd,
    async exec(command: string, options?: ShellExecOptions): Promise<ShellResult> {
      if (options?.signal?.aborted) throw abortError();

      const mergedSignal = composeSignals(options?.timeoutMs, options?.signal);
      if (mergedSignal?.aborted) throw abortError();

      const result = await execShell(command, {
        cwd: options?.cwd ?? cwd,
        env: options?.env ? { ...baseEnv, ...options.env } : baseEnv,
        signal: mergedSignal,
      });

      if (options?.signal?.aborted) throw abortError();
      return result;
    },
  };
}