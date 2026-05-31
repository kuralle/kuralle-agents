import { describe, expect, it } from 'bun:test';

describe('VAD loader retry pattern (Phase 3 fix: H5)', () => {
  it('failed load clears loadingPromise so retry is possible', async () => {
    let cachedResult: string | null = null;
    let loadingPromise: Promise<string> | null = null;
    let loadAttempts = 0;

    // Simulates the exact pattern from vad_loader.ts
    async function simulatedLoad(): Promise<string> {
      if (cachedResult) return cachedResult;
      if (loadingPromise) return loadingPromise;

      loadingPromise = new Promise<string>(async (resolve, reject) => {
        try {
          loadAttempts++;
          // Simulate async work
          await Promise.resolve();
          if (loadAttempts === 1) {
            throw new Error('first load fails');
          }
          cachedResult = 'loaded';
          resolve(cachedResult);
        } catch (err) {
          reject(err);
        } finally {
          loadingPromise = null;
        }
      });

      return loadingPromise;
    }

    // First call should fail
    let firstError: Error | null = null;
    try {
      await simulatedLoad();
    } catch (err) {
      firstError = err as Error;
    }
    expect(firstError?.message).toBe('first load fails');
    expect(loadAttempts).toBe(1);
    expect(cachedResult).toBeNull();
    // Key assertion: loadingPromise was cleared by finally
    expect(loadingPromise).toBeNull();

    // Second call should retry (not return cached rejected promise)
    const result = await simulatedLoad();
    expect(result).toBe('loaded');
    expect(loadAttempts).toBe(2);

    // Third call should use cache
    const cached = await simulatedLoad();
    expect(cached).toBe('loaded');
    expect(loadAttempts).toBe(2);
  });

  it('concurrent callers share the same loading promise', async () => {
    let cachedResult: string | null = null;
    let loadingPromise: Promise<string> | null = null;
    let loadAttempts = 0;

    async function loadConcurrent(): Promise<string> {
      if (cachedResult) return cachedResult;
      if (loadingPromise) return loadingPromise;

      loadingPromise = new Promise<string>(async (resolve, reject) => {
        try {
          loadAttempts++;
          await new Promise((r) => setTimeout(r, 10));
          cachedResult = 'loaded';
          resolve(cachedResult);
        } catch (err) {
          reject(err);
        } finally {
          loadingPromise = null;
        }
      });

      return loadingPromise;
    }

    const [r1, r2, r3] = await Promise.all([
      loadConcurrent(),
      loadConcurrent(),
      loadConcurrent(),
    ]);

    expect(r1).toBe('loaded');
    expect(r2).toBe('loaded');
    expect(r3).toBe('loaded');
    expect(loadAttempts).toBe(1);
  });
});
