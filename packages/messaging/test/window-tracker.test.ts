import { describe, it, expect } from 'bun:test';
import { WindowTracker } from '../src/adapter/window-tracker.js';

describe('WindowTracker', () => {
  it('isWindowOpen returns false for unknown threads', () => {
    const tracker = new WindowTracker();
    expect(tracker.isWindowOpen('unknown-thread')).toBe(false);
  });

  it('after recordInbound, window is open', () => {
    const tracker = new WindowTracker();
    tracker.recordInbound('thread-1', new Date());
    expect(tracker.isWindowOpen('thread-1')).toBe(true);
  });

  it('window expires after 24 hours', () => {
    const tracker = new WindowTracker();
    // Simulate an inbound message from 25 hours ago
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    tracker.recordInbound('thread-1', twentyFiveHoursAgo);
    expect(tracker.isWindowOpen('thread-1')).toBe(false);
  });

  it('window is open if inbound was less than 24 hours ago', () => {
    const tracker = new WindowTracker();
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
    tracker.recordInbound('thread-1', twentyThreeHoursAgo);
    expect(tracker.isWindowOpen('thread-1')).toBe(true);
  });

  it('recordExpiry with explicit future date keeps window open', () => {
    const tracker = new WindowTracker();
    const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    tracker.recordExpiry('thread-1', futureDate);
    expect(tracker.isWindowOpen('thread-1')).toBe(true);
  });

  it('recordExpiry with past date closes window', () => {
    const tracker = new WindowTracker();
    const pastDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    tracker.recordExpiry('thread-1', pastDate);
    expect(tracker.isWindowOpen('thread-1')).toBe(false);
  });

  it('recordInbound only extends window, never shrinks it', () => {
    const tracker = new WindowTracker();

    // First message: 1 hour ago -> window expires in 23 hours
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    tracker.recordInbound('thread-1', oneHourAgo);
    const firstExpiry = tracker.getExpiry('thread-1')!;

    // Second message: 5 hours ago -> would set window to expire in 19 hours (earlier)
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    tracker.recordInbound('thread-1', fiveHoursAgo);
    const secondExpiry = tracker.getExpiry('thread-1')!;

    // Window should not have shrunk
    expect(secondExpiry.getTime()).toBe(firstExpiry.getTime());
  });

  it('recordInbound extends window when new message is more recent', () => {
    const tracker = new WindowTracker();

    // First message: 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    tracker.recordInbound('thread-1', fiveHoursAgo);
    const firstExpiry = tracker.getExpiry('thread-1')!;

    // Second message: just now -> window extends further
    tracker.recordInbound('thread-1', new Date());
    const secondExpiry = tracker.getExpiry('thread-1')!;

    expect(secondExpiry.getTime()).toBeGreaterThan(firstExpiry.getTime());
  });

  it('getExpiry returns the correct date', () => {
    const tracker = new WindowTracker();
    const now = new Date();
    tracker.recordInbound('thread-1', now);

    const expiry = tracker.getExpiry('thread-1');
    expect(expiry).not.toBeNull();

    // Expected expiry is now + 24 hours
    const expectedExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(expiry!.getTime()).toBe(expectedExpiry.getTime());
  });

  it('getExpiry returns null for unknown threads', () => {
    const tracker = new WindowTracker();
    expect(tracker.getExpiry('nonexistent')).toBeNull();
  });

  it('size reflects the number of tracked threads', () => {
    const tracker = new WindowTracker();
    expect(tracker.size).toBe(0);

    tracker.recordInbound('thread-1', new Date());
    expect(tracker.size).toBe(1);

    tracker.recordInbound('thread-2', new Date());
    expect(tracker.size).toBe(2);

    // Recording to an existing thread should not increase size
    tracker.recordInbound('thread-1', new Date());
    expect(tracker.size).toBe(2);
  });

  it('clear() removes all tracked windows', () => {
    const tracker = new WindowTracker();
    tracker.recordInbound('thread-1', new Date());
    tracker.recordInbound('thread-2', new Date());
    expect(tracker.size).toBe(2);

    tracker.clear();
    expect(tracker.size).toBe(0);
    expect(tracker.isWindowOpen('thread-1')).toBe(false);
    expect(tracker.isWindowOpen('thread-2')).toBe(false);
  });

  it('recordExpiry overwrites existing window (can shrink)', () => {
    const tracker = new WindowTracker();

    // Open a window via inbound (expires in ~24h)
    tracker.recordInbound('thread-1', new Date());
    expect(tracker.isWindowOpen('thread-1')).toBe(true);

    // Platform reports window already expired
    const pastDate = new Date(Date.now() - 1000);
    tracker.recordExpiry('thread-1', pastDate);
    expect(tracker.isWindowOpen('thread-1')).toBe(false);
  });
});
