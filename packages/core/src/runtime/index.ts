export {
  createRuntime,
  Runtime,
  type HarnessConfig,
  type RunOptions,
  type TracingConfig,
} from './Runtime.js';
export type { RuntimeLike } from './RuntimeLike.js';
export { TraceRecorder, runOnce, type TraceRecorderOptions } from './TraceRecorder.js';
export type { AgentSpan, AgentTrace, SpanKind } from '../types/trace.js';
export { SessionWorkingMemory } from './WorkingMemory.js';
export {
  TextDriver,
  AiSdkModelTurnLoop,
  buildDecideSystem,
  type TextDriverConfig,
  type ModelTurnLoop,
  type ModelTurnLoopInput,
  type ModelTurnLoopState,
  dispatchModelToolCalls,
  toolResultMessage,
  type ModelToolCall,
  type ModelToolCallOutcome,
} from './channels/index.js';
export {
  prepareStructuredDecide,
  type PreparedStructuredDecision,
} from '../flow/choiceMatch.js';
// Pending-input buffer helpers — required by custom ChannelDriver authors to
// implement awaitUser the same FIFO-aware way the built-in drivers do (the
// buffer is an ordered queue since 0.3.13/H3, not a single slot).
export {
  setPendingUserInput,
  consumePendingUserInput,
  consumeAllPendingUserInput,
  peekPendingUserInput,
  hasPendingUserInput,
} from './channels/index.js';
// Multimodal user input — `UserInputContent` is the runtime's accepted user-turn
// shape (text or AI SDK file/image/audio parts). Helpers project to text and
// transcribe audio so ingress adapters (web/messaging) can build it uniformly.
export {
  userInputToText,
  mergeUserInputContents,
  hasMediaParts,
  transcribeAudioParts,
  type UserInputContent,
} from './userInput.js';

export {
  isAbortSignal,
  type InterruptionEvent,
  type AbortOptions,
  type CancellationReason,
} from '../types/index.js';
