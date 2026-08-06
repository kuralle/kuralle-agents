import type { RunState } from '../../runtime/durable/types.js';
import type { RunStore } from '../../runtime/durable/RunStore.js';
import {
  detectTurnHadToolCalls,
  shouldExtract,
  type ExtractionConfig,
} from './trigger.js';

export function extractionSucceeded(result: {
  values: Record<string, unknown>;
  failures: Array<{ slug: string; error: string }>;
}): boolean {
  if (result.failures.length === 0) {
    return true;
  }
  return Object.keys(result.values).length > 0;
}

export interface RunExtractionAtCloseOptions {
  runState: RunState;
  runStore: RunStore;
  config: ExtractionConfig;
  turnMessageBaseline: number;
  run: () => Promise<boolean>;
  trackBackground: (promise: Promise<void>) => void;
}

/** Applies trigger policy at turn close; advances `lastExtractedMessageCount` on success. */
export async function runExtractionAtClose(
  options: RunExtractionAtCloseOptions,
): Promise<void> {
  const trigger = options.config.trigger;
  if (!trigger) {
    return;
  }

  const turnHadToolCalls = detectTurnHadToolCalls(
    options.runState.messages,
    options.turnMessageBaseline,
  );
  if (!shouldExtract(options.runState, trigger, turnHadToolCalls)) {
    return;
  }

  const promise = options
    .run()
    .then(async (success) => {
      if (success) {
        options.runState.lastExtractedMessageCount = options.runState.messages.length;
        await options.runStore.putRunState(options.runState);
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[Kuralle] extraction failed:', message);
    });

  if (options.config.blocking) {
    await promise;
  } else {
    options.trackBackground(promise);
  }
}
