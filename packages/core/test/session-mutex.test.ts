/**
 * TDD tests for SessionMutex.
 *
 * These tests verify that concurrent stream() calls for the same
 * sessionId are serialized, while calls for different sessionIds
 * run in parallel.
 */

import { describe, it, expect } from 'bun:test';
import { SessionMutex } from '../src/runtime/SessionMutex.ts';

describe('SessionMutex', () => {
  it('acquire resolves immediately when session is unlocked', async () => {
    const mutex = new SessionMutex();
    const release = await mutex.acquire('session-1');
    expect(typeof release).toBe('function');
    release();
  });

  it('serializes two concurrent acquires for the same session', async () => {
    const mutex = new SessionMutex();
    const order: string[] = [];

    // First lock
    const release1 = await mutex.acquire('session-1');
    order.push('lock1-acquired');

    // Second lock — should NOT resolve until release1() is called
    const lock2Promise = mutex.acquire('session-1').then((release2) => {
      order.push('lock2-acquired');
      release2();
      order.push('lock2-released');
    });

    // Give microtasks a chance to run
    await new Promise(r => setTimeout(r, 50));

    // lock2 should still be waiting
    expect(order).toEqual(['lock1-acquired']);

    // Release lock1 — lock2 should now proceed
    release1();
    order.push('lock1-released');
    await lock2Promise;

    expect(order).toEqual([
      'lock1-acquired',
      'lock1-released',
      'lock2-acquired',
      'lock2-released',
    ]);
  });

  it('allows parallel acquires for different sessions', async () => {
    const mutex = new SessionMutex();
    const order: string[] = [];

    const release1 = await mutex.acquire('session-A');
    order.push('A-acquired');

    const release2 = await mutex.acquire('session-B');
    order.push('B-acquired');

    // Both acquired without waiting
    expect(order).toEqual(['A-acquired', 'B-acquired']);

    release1();
    release2();
  });

  it('queues three concurrent acquires for the same session', async () => {
    const mutex = new SessionMutex();
    const order: number[] = [];

    const release1 = await mutex.acquire('q-session');
    order.push(1);

    const p2 = mutex.acquire('q-session').then(r => { order.push(2); return r; });
    const p3 = mutex.acquire('q-session').then(r => { order.push(3); return r; });

    await new Promise(r => setTimeout(r, 50));
    expect(order).toEqual([1]); // Only first acquired

    release1();
    const release2 = await p2;
    expect(order).toEqual([1, 2]); // Second acquired after first released

    release2();
    const release3 = await p3;
    expect(order).toEqual([1, 2, 3]); // Third acquired after second released

    release3();
  });

  it('cleans up map entry when last lock is released', async () => {
    const mutex = new SessionMutex();
    expect(mutex.size).toBe(0);

    const release = await mutex.acquire('cleanup-session');
    expect(mutex.size).toBe(1);

    release();
    expect(mutex.size).toBe(0);
  });

  it('release in finally block works even on errors', async () => {
    const mutex = new SessionMutex();
    const order: string[] = [];

    // Simulate a turn that throws
    try {
      const release = await mutex.acquire('error-session');
      try {
        order.push('working');
        throw new Error('Turn crashed');
      } finally {
        release();
        order.push('released');
      }
    } catch {
      order.push('caught');
    }

    // The lock should be released — next acquire should work immediately
    const release2 = await mutex.acquire('error-session');
    order.push('reacquired');
    release2();

    expect(order).toEqual(['working', 'released', 'caught', 'reacquired']);
  });

  it('simulates concurrent session writes with mutex preventing race', async () => {
    const mutex = new SessionMutex();

    // Shared state simulating a session
    let sessionMessages: string[] = [];

    async function simulateTurn(turnId: string, delayMs: number): Promise<void> {
      const release = await mutex.acquire('shared-session');
      try {
        // Read
        const snapshot = [...sessionMessages];
        // Simulate LLM work
        await new Promise(r => setTimeout(r, delayMs));
        // Write (append)
        snapshot.push(`msg-from-${turnId}`);
        sessionMessages = snapshot;
      } finally {
        release();
      }
    }

    // Run two turns concurrently
    await Promise.all([
      simulateTurn('turn1', 100),
      simulateTurn('turn2', 50),
    ]);

    // Without mutex: last-write-wins, one message lost
    // With mutex: both messages present, serialized
    expect(sessionMessages.length).toBe(2);
    expect(sessionMessages).toContain('msg-from-turn1');
    expect(sessionMessages).toContain('msg-from-turn2');
  });

  it('does not deadlock on rapid acquire/release cycles', async () => {
    const mutex = new SessionMutex();
    const count = 100;
    let completed = 0;

    const promises = Array.from({ length: count }, async (_, i) => {
      const release = await mutex.acquire('rapid-session');
      completed++;
      release();
    });

    await Promise.all(promises);
    expect(completed).toBe(count);
    expect(mutex.size).toBe(0);
  });
});
