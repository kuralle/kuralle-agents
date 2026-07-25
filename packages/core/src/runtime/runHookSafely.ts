type HookCallback = () => void | Promise<void>;

export function runHookSafely(name: string, callback: HookCallback | undefined): Promise<void> {
  if (!callback) return Promise.resolve();

  try {
    return Promise.resolve(callback()).catch((error) => reportHookError(name, error));
  } catch (error) {
    reportHookError(name, error);
    return Promise.resolve();
  }
}

function reportHookError(name: string, error: unknown): void {
  try {
    console.error(`Hook ${name} failed`, error);
  } catch {
    // Hook failure reporting must not affect run correctness.
  }
}
