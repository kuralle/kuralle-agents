export const DEFAULT_ERROR_MESSAGES: Record<string, string> = {
  generic: 'I encountered an issue while processing your request. Please try again.',
  not_found: "I couldn't find the information you're looking for. Could you double-check the details?",
  invalid_input: 'The information provided seems incorrect. Please verify and try again.',
  unauthorized: "I'm sorry, I don't have permission to access that information.",
  forbidden: "I'm not able to perform that action. Please contact support if you believe this is an error.",
  timeout: 'This is taking longer than expected. Please try again.',
  network: 'I seem to be having trouble connecting. Please check your connection and try again.',
  rate_limit: "I'm receiving too many requests. Please wait a moment and try again.",
  validation: 'The information provided is incomplete or incorrect. Please provide more details.',
  concurrency: 'Another operation is in progress. Please wait and try again.',
  not_implemented: "I'm not able to perform that action yet. Please contact support for assistance.",
  deprecated: 'This feature is no longer available. Please use the updated version.',
  permission_denied: "You don't have permission to perform this action.",
  resource_exhausted: 'The system is currently overloaded. Please try again later.',
};

export type ErrorCategory = keyof typeof DEFAULT_ERROR_MESSAGES;

export function getUserFriendlyError(
  error: Error | unknown,
  customMessages?: Record<string, string>
): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const category = categorizeError(errorMessage);

  const messages = { ...DEFAULT_ERROR_MESSAGES, ...customMessages };
  return messages[category] ?? messages.generic;
}

export function categorizeError(errorMessage: string): ErrorCategory {
  const message = errorMessage.toLowerCase();

  if (message.includes('not found') || message.includes('does not exist')) {
    return 'not_found';
  }
  if (message.includes('invalid') || message.includes('malformed')) {
    return 'invalid_input';
  }
  if (message.includes('unauthorized') || message.includes('not authenticated')) {
    return 'unauthorized';
  }
  if (message.includes('forbidden') || message.includes('access denied')) {
    return 'forbidden';
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  if (message.includes('network') || message.includes('connection')) {
    return 'network';
  }
  if (message.includes('rate limit') || message.includes('too many requests')) {
    return 'rate_limit';
  }
  if (message.includes('validation') || message.includes('required')) {
    return 'validation';
  }
  if (message.includes('concurrent') || message.includes('conflict')) {
    return 'concurrency';
  }
  if (message.includes('not implemented') || message.includes('unsupported')) {
    return 'not_implemented';
  }
  if (message.includes('deprecated') || message.includes('obsolete')) {
    return 'deprecated';
  }
  if (message.includes('permission') || message.includes('access')) {
    return 'permission_denied';
  }
  if (message.includes('resource') || message.includes('quota')) {
    return 'resource_exhausted';
  }

  return 'generic';
}

export function createErrorResponse(
  userMessage: string,
  metadata?: {
    errorCode?: string;
    correlationId?: string;
    suggestedActions?: string[];
  }
): { error: string; metadata?: Record<string, unknown> } {
  const response: { error: string; metadata?: Record<string, unknown> } = {
    error: userMessage,
  };

  if (metadata) {
    response.metadata = {};
    if (metadata.errorCode) response.metadata.errorCode = metadata.errorCode;
    if (metadata.correlationId) response.metadata.correlationId = metadata.correlationId;
    if (metadata.suggestedActions) response.metadata.suggestedActions = metadata.suggestedActions;
  }

  return response;
}
