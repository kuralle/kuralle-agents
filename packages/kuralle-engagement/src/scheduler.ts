/**
 * The scheduler contract is owned by `@kuralle-agents/core` — one interface
 * for engagement send-jobs and runtime wake turns (broadcasts, drips, and
 * proactive agent-initiated messages share backends: in-process timers in
 * dev, DO alarms on Cloudflare, any queue in between). Re-exported here so
 * existing engagement consumers keep their import path.
 */
import type { ScheduledJob } from '@kuralle-agents/core';

export { createInProcessScheduler } from '@kuralle-agents/core';
export type { Scheduler, InjectableTimer } from '@kuralle-agents/core';

/** A unit of deferred engagement work (broadcast step / drip step). */
export type SendJob = ScheduledJob;
