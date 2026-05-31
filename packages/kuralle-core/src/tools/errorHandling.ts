export interface ToolErrorConfig<T = unknown> {
  maxRetries?: number;
  retryDelayMs?: number;
  fallbackValue?: T;
  onError?: (error: Error, attempt: number) => Promise<void>;
  shouldRetry?: (error: Error) => boolean;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalTimeMs: number;
}

export function withErrorHandling<T, Args extends unknown[], R = Awaited<T>>(
  fn: (...args: Args) => T,
  config: ToolErrorConfig<R> = {}
): (...args: Args) => Promise<ToolResult<R>> {
  const {
    maxRetries = 3,
    retryDelayMs = 1000,
    fallbackValue,
    onError,
    shouldRetry = (e) => !isPermanentError(e),
  } = config;

  return async (...args: Args): Promise<ToolResult<R>> => {
    const startTime = Date.now();
    let lastError: Error | undefined;
    let attempts = 0;

    while (attempts <= maxRetries) {
      attempts++;
      try {
        const result = await fn(...args) as R;
        return {
          success: true,
          data: result,
          attempts,
          totalTimeMs: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error as Error;

        if (onError) {
          await onError(lastError, attempts);
        }

        if (attempts <= maxRetries && shouldRetry(lastError)) {
          await sleep(retryDelayMs * attempts);
        } else {
          break;
        }
      }
    }

    return {
      success: false,
      error: lastError,
      attempts,
      totalTimeMs: Date.now() - startTime,
      data: fallbackValue,
    };
  };
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config: {
    maxRetries?: number;
    delayMs?: number;
    backoffMultiplier?: number;
    maxDelayMs?: number;
    onRetry?: (error: Error, attempt: number) => void;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    delayMs = 1000,
    backoffMultiplier = 2,
    maxDelayMs = 10000,
    onRetry,
  } = config;

  let lastError: Error | undefined;
  let currentDelay = delayMs;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (isPermanentError(lastError) || attempt > maxRetries) {
        throw lastError;
      }

      if (onRetry) {
        onRetry(lastError, attempt);
      }

      await sleep(currentDelay);
      currentDelay = Math.min(currentDelay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export function createCircuitBreaker<T, Args extends unknown[]>(
  fn: (...args: Args) => Promise<T>,
  config: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
  } = {}
): (...args: Args) => Promise<T> {
  const {
    failureThreshold = 5,
    resetTimeoutMs = 30000,
  } = config;

  let failures = 0;
  let lastFailureTime: number | undefined;
  let state: CircuitState = 'CLOSED';

  return async (...args: Args): Promise<T> => {
    const now = Date.now();

    if (state === 'OPEN') {
      if (lastFailureTime && now - lastFailureTime >= resetTimeoutMs) {
        state = 'HALF_OPEN';
      } else {
        throw new CircuitOpenError('Circuit breaker is open');
      }
    }

    try {
      const result = await fn(...args);

      if (state === 'HALF_OPEN') {
        state = 'CLOSED';
        failures = 0;
      } else {
        failures = 0; // Success in CLOSED state resets failure count
      }

      return result;
    } catch (error) {
      failures++;
      lastFailureTime = now;

      if (state === 'HALF_OPEN' || failures >= failureThreshold) {
        state = 'OPEN';
      }

      throw error;
    }
  };
}

export function isPermanentError(error: Error): boolean {
  const permanentErrors = [
    'not found',
    'invalid',
    'unauthorized',
    'forbidden',
    'not implemented',
    'deprecated',
    'already exists',
    'permission denied',
  ];

  const message = error.message.toLowerCase();
  return permanentErrors.some((e) => message.includes(e));
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError;
}

export class ToolTimeoutError extends Error {
  constructor(message: string = 'Tool execution timed out') {
    super(message);
    this.name = 'ToolTimeoutError';
  }
}

export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  error?: Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(error ?? new ToolTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
