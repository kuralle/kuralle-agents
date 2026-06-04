import { ToolValidationError } from '../tools/effect/schema.js';
import { FlowOscillationError } from './runFlow.js';

export function isDegradableRuntimeError(error: unknown): boolean {
  return error instanceof ToolValidationError || error instanceof FlowOscillationError;
}
