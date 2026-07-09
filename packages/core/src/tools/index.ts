export type { Tool, ToolSet, ToolDefinition, ToolWithFiller } from './Tool.js';
export { createTool, createToolWithFiller } from './Tool.js';
export { createHandoffTool, isHandoffResult } from './handoff.js';
export type { HandoffResult } from './handoff.js';
export { isFinalResult } from './final.js';
export type { FinalResult } from './final.js';
export { createHttpTool } from './http.js';
export type {
  HttpToolConfig,
  HttpToolResult,
  HttpParam,
  ParamType,
  HttpMethod,
  AuthConfig,
} from './http.types.js';

export {
  withErrorHandling,
  executeWithRetry,
  createCircuitBreaker,
  withTimeout,
  isPermanentError,
  isCircuitOpenError,
  CircuitOpenError,
  ToolTimeoutError,
  type ToolErrorConfig,
  type ToolResult,
} from './errorHandling.js';

export {
  DEFAULT_ERROR_MESSAGES,
  getUserFriendlyError,
  categorizeError,
  createErrorResponse,
  type ErrorCategory,
} from './errorMessages.js';
