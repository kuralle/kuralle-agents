export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Shell {
  exec(command: string, options?: ShellExecOptions): Promise<ShellResult>;
  cwd?: string;
}