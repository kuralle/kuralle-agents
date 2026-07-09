import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getAgentByName } from 'agents';
import type { ScheduledJob } from '@kuralle-agents/core';
import type { TestWakeAgent } from './worker.js';

interface TestWakeEnv {
  TEST_WAKE_AGENT: DurableObjectNamespace<TestWakeAgent>;
}

describe('DO-alarm wake scheduler', () => {
  it('schedules a wake job through real DO alarms and delivers it to the callback', async () => {
    const bindings = env as unknown as TestWakeEnv;
    const stub = await getAgentByName(bindings.TEST_WAKE_AGENT, 'wake-parity');

    const scheduled = await stub.fetch('http://do/schedule-wake', { method: 'POST' });
    expect(scheduled.ok).toBe(true);
    const { jobId } = (await scheduled.json()) as { jobId: string };
    expect(typeof jobId).toBe('string');

    // A zero-delay schedule's alarm usually self-fires before we can trigger
    // it; runDurableObjectAlarm is the fallback when it hasn't yet.
    let job: ScheduledJob | null = null;
    for (let attempt = 0; attempt < 20 && !job; attempt += 1) {
      const response = await stub.fetch('http://do/last-job');
      job = ((await response.json()) as { job: ScheduledJob | null }).job;
      if (!job) {
        await runDurableObjectAlarm(stub);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(job?.kind).toBe('kuralle.wake');
    expect(job?.payload.reason).toBe('test-nudge');
    expect((job?.payload.payload as { cartId?: string })?.cartId).toBe('cart-9');
    expect(typeof job?.payload.sessionId).toBe('string');
  });
});
