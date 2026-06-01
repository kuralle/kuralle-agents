/** A unit of deferred work (broadcast step / drip step). Shape is engagement-internal. */
export interface SendJob {
  kind: string;
  payload: Record<string, unknown>;
}

export interface Scheduler {
  enqueue(job: SendJob, opts?: { delayMs?: number }): Promise<string>;
  cancel(jobId: string): Promise<void>;
}

export type InjectableTimer = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const defaultTimer: InjectableTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Default in-process scheduler (timer-based). For single-process/dev.
 * Production adapters (interface-compatible, not implemented here):
 *   - BullMQ (Redis-backed queue)
 *   - Google Cloud Tasks
 *   - cron / system scheduler
 * Inject a durable adapter for multi-process / serverless.
 */
export function createInProcessScheduler(opts: {
  run: (job: SendJob) => void | Promise<void>;
  timer?: InjectableTimer;
}): Scheduler {
  const timer = opts.timer ?? defaultTimer;
  let nextJobId = 0;
  const handles = new Map<string, unknown>();

  return {
    async enqueue(job, options) {
      const jobId = String(++nextJobId);
      const delayMs = options?.delayMs ?? 0;
      const handle = timer.set(() => {
        handles.delete(jobId);
        void opts.run(job);
      }, delayMs);
      handles.set(jobId, handle);
      return jobId;
    },

    async cancel(jobId) {
      const handle = handles.get(jobId);
      if (handle === undefined) return;
      timer.clear(handle);
      handles.delete(jobId);
    },
  };
}
