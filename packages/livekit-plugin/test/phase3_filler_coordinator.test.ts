import { describe, expect, it } from 'bun:test';
import { FillerCoordinator } from '../src/filler/FillerCoordinator.js';
import type { FillerSpeakSession } from './livekit_stubs.js';

describe('FillerCoordinator (Phase 3 fix: M6)', () => {
  it('waitForActiveFillers resolves immediately when no fillers are active', async () => {
    const coordinator = new FillerCoordinator();
    // Should not hang
    await coordinator.waitForActiveFillers();
  });

  it('waitForActiveFillers waits for a single filler to complete', async () => {
    const coordinator = new FillerCoordinator();

    let fillerComplete = false;
    let resolveWaitForPlayout!: () => void;

    // @ts-expect-error — test-only mock; SpeechHandle has many fields we don't need
    const mockSession = {
      say: () => ({
        waitForPlayout: () =>
          new Promise<void>((resolve) => {
            resolveWaitForPlayout = () => {
              fillerComplete = true;
              resolve();
            };
          }),
      }),
    } as FillerSpeakSession;

    coordinator.speakFiller(mockSession, 'hmm');

    // Start waiting -- should not resolve yet
    let waitDone = false;
    const waitPromise = coordinator.waitForActiveFillers().then(() => {
      waitDone = true;
    });

    // Give the event loop a tick
    await new Promise((r) => setTimeout(r, 5));
    expect(waitDone).toBe(false);
    expect(fillerComplete).toBe(false);

    // Complete the filler
    resolveWaitForPlayout();
    await waitPromise;

    expect(waitDone).toBe(true);
    expect(fillerComplete).toBe(true);
  });

  it('M6 fix: waitForActiveFillers waits for ALL fillers, not just the latest', async () => {
    const coordinator = new FillerCoordinator();

    const resolvers: Array<() => void> = [];

    // @ts-expect-error — test-only mock; SpeechHandle has many fields we don't need
    const mockSession = {
      say: () => ({
        waitForPlayout: () =>
          new Promise<void>((resolve) => {
            resolvers.push(resolve);
          }),
      }),
    } as FillerSpeakSession;

    // Fire two fillers rapidly
    coordinator.speakFiller(mockSession, 'hmm');
    coordinator.speakFiller(mockSession, 'one moment');

    expect(resolvers.length).toBe(2);

    let waitDone = false;
    const waitPromise = coordinator.waitForActiveFillers().then(() => {
      waitDone = true;
    });

    // Resolve only the second (latest) filler
    resolvers[1]();
    await new Promise((r) => setTimeout(r, 5));

    // Should NOT be done yet -- first filler is still playing
    expect(waitDone).toBe(false);

    // Now resolve the first filler
    resolvers[0]();
    await waitPromise;

    // Now it should be done
    expect(waitDone).toBe(true);
  });

  it('speakFiller ignores empty text', async () => {
    const coordinator = new FillerCoordinator();

    let sayCalled = false;
    // @ts-expect-error — test-only mock; SpeechHandle has many fields we don't need
    const mockSession = {
      say: () => {
        sayCalled = true;
        return {
          waitForPlayout: () => Promise.resolve(),
        };
      },
    } as FillerSpeakSession;

    await coordinator.speakFiller(mockSession, '   ');
    expect(sayCalled).toBe(false);
  });
});
