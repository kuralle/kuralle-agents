export {
  createRuntime,
  Runtime,
  type HarnessConfig,
  type RunOptions,
} from './Runtime.js';
export type { RuntimeLike } from './RuntimeLike.js';
export { SessionWorkingMemory } from './WorkingMemory.js';
export { TextDriver, VoiceDriver } from './channels/index.js';
export type { VoiceDriverConfig } from './channels/index.js';
// Pending-input buffer helpers — required by custom ChannelDriver authors to
// implement awaitUser the same FIFO-aware way the built-in drivers do (the
// buffer is an ordered queue since 0.3.13/H3, not a single slot).
export {
  setPendingUserInput,
  consumePendingUserInput,
  peekPendingUserInput,
  hasPendingUserInput,
} from './channels/index.js';

export {
  isAbortSignal,
  type InterruptionEvent,
  type AbortOptions,
  type CancellationReason,
} from '../types/index.js';
