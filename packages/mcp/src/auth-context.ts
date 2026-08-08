import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuthRequestContext {
  generatedHeaders: Record<string, string>;
}

/** Per-execute auth headers — never persisted; scoped to the active tool call. */
export const mcpAuthContext = new AsyncLocalStorage<AuthRequestContext>();

export function withAuthContext<T>(
  generatedHeaders: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  return mcpAuthContext.run({ generatedHeaders }, fn);
}

export function activeGeneratedHeaders(): Record<string, string> {
  return mcpAuthContext.getStore()?.generatedHeaders ?? {};
}
