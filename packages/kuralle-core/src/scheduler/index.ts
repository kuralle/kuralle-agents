import { z } from 'zod';
import { defineTool } from '../tools/effect/defineTool.js';
import type { Tool } from '../types/effectTool.js';
import type { HarnessStreamPart, TurnHandle } from '../types/stream.js';

/**
 * Deferred-work scheduling for proactive (agent-initiated) turns.
 *
 * One `Scheduler` contract across the framework: the engagement layer's
 * broadcast/drip jobs and the runtime's wake turns ride the same interface.
 * Backends: `createInProcessScheduler` (dev, timer-based), Cloudflare DO
 * alarms via `@kuralle-agents/cf-agent`, or any queue (BullMQ, Cloud Tasks)
 * implementing the two methods.
 */
export interface ScheduledJob {
  kind: string;
  payload: Record<string, unknown>;
}

export interface Scheduler {
  enqueue(job: ScheduledJob, opts?: { delayMs?: number }): Promise<string>;
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
 * Inject a durable adapter (DO alarms, BullMQ, Cloud Tasks) for
 * multi-process / serverless.
 */
export function createInProcessScheduler(opts: {
  run: (job: ScheduledJob) => void | Promise<void>;
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

// ── Wake jobs (agent-initiated turns) ────────────────────────────────────────

export const WAKE_JOB_KIND = 'kuralle.wake';

export interface WakeOptions {
  /** Why the agent is waking — composed into the wake note the model sees. */
  reason: string;
  /** Structured context for the wake turn (e.g. the abandoned cart id). */
  payload?: Record<string, unknown>;
}

export interface WakeJobPayload extends WakeOptions {
  sessionId: string;
}

export function wakeJob(wake: WakeJobPayload): ScheduledJob {
  return { kind: WAKE_JOB_KIND, payload: { ...wake } };
}

export function isWakeJob(job: ScheduledJob): boolean {
  return job.kind === WAKE_JOB_KIND;
}

/** What a wake turn produced — handed to the host's delivery function. */
export interface WakeDelivery {
  sessionId: string;
  reason: string;
  payload?: Record<string, unknown>;
  /** Full stream of the wake turn (text, tool events, interactive parts…). */
  parts: HarnessStreamPart[];
  /** Concatenated assistant text of the wake turn. */
  text: string;
}

/** The runtime surface a wake runner needs (satisfied by `Runtime`). */
export interface WakeRunnable {
  run(opts: { sessionId: string; wake: WakeOptions }): TurnHandle;
}

/**
 * Build the scheduler executor for wake jobs: runs the agent-initiated turn
 * and hands the produced parts to `deliver` (e.g. the messaging outbound
 * pipeline — which keeps the send window-safe). Compose with your own job
 * kinds: `run: (job) => isWakeJob(job) ? runWake(job) : runMine(job)`.
 */
export function createWakeJobRunner(
  runtime: WakeRunnable,
  opts: {
    deliver: (delivery: WakeDelivery) => Promise<void>;
    onError?: (error: unknown, job: ScheduledJob) => void;
  },
): (job: ScheduledJob) => Promise<void> {
  return async (job) => {
    if (!isWakeJob(job)) {
      return;
    }
    const { sessionId, reason, payload } = job.payload as unknown as WakeJobPayload;
    try {
      const handle = runtime.run({ sessionId, wake: { reason, payload } });
      const parts: HarnessStreamPart[] = [];
      let text = '';
      for await (const part of handle.events) {
        parts.push(part);
        if (part.type === 'text-delta') {
          text += part.delta;
        }
      }
      const result = await handle;
      await opts.deliver({ sessionId, reason, payload, parts, text: text || result.text });
    } catch (error) {
      if (opts.onError) {
        opts.onError(error, job);
      } else {
        console.warn(`[Kuralle] wake turn failed for session ${sessionId}:`, error);
      }
    }
  };
}

const scheduleFollowupInput = z.object({
  delayMinutes: z.number().min(1).describe('How many minutes from now to follow up'),
  reason: z
    .string()
    .describe('Why the follow-up is needed, e.g. "user said they would decide after lunch"'),
});

/**
 * Durable tool letting the agent schedule its own follow-up wake turn
 * ("I'll check back in an hour"). Safe for `globalTools` — it only schedules;
 * the wake turn itself goes through the full guard/window pipeline.
 */
export function createScheduleFollowupTool(
  scheduler: Scheduler,
): Tool<z.infer<typeof scheduleFollowupInput>, { scheduled: boolean; jobId: string; inMinutes: number }> {
  return defineTool({
    name: 'schedule_followup',
    description:
      'Schedule a follow-up message to the user after a delay. Use when the user asks you to check back later, or a pending task warrants a proactive follow-up.',
    input: scheduleFollowupInput,
    execute: async (args, ctx) => {
      const sessionId = ctx?.session.id;
      if (!sessionId) {
        throw new Error('schedule_followup requires a session context');
      }
      const jobId = await scheduler.enqueue(
        wakeJob({ sessionId, reason: args.reason }),
        { delayMs: Math.round(args.delayMinutes * 60_000) },
      );
      return { scheduled: true, jobId, inMinutes: args.delayMinutes };
    },
  });
}
